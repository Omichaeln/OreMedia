import { inflateRawSync } from 'node:zlib';
import {
  SOURCE_DOCUMENT_MAX_BYTES,
  SOURCE_PDF_MAX_PAGES,
  SOURCE_TEXT_MAX_CHARS,
  type BrandSourceReason,
} from '@oremedia/contracts/brand-assist';
import { scanMarkup } from '@oremedia/providers/markup';
import { decodeEntities } from '@oremedia/providers/site-rules';
import { tidyText } from './html-text';

/**
 * BSC-4: the text of an uploaded document, read on the isolated worker (spec 4.4: untrusted-input parsers live on
 * worker-render). PDF through pdf.js (unpdf, MIT; no script evaluation, no fonts, at most SOURCE_PDF_MAX_PAGES pages),
 * Word .docx through a bounded zip reader (every entry inflated with a hard output cap, so a zip bomb stops at the cap
 * rather than exhausting memory), Markdown and plain text as UTF-8. Each refuses with a reason a person can act on.
 */
export class DocumentRefusal extends Error {
  constructor(
    readonly reason: BrandSourceReason,
    readonly detail: string | null = null,
  ) {
    super(reason);
    this.name = 'DocumentRefusal';
  }
}

export interface ExtractedDocument {
  text: string;
  truncated: boolean;
  pages: number | null;
}

/** Cuts text at the source cap without splitting a surrogate pair. */
export function capText(text: string, max = SOURCE_TEXT_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

export async function extractDocument(bytes: Buffer, mime: string): Promise<ExtractedDocument> {
  if (bytes.length > SOURCE_DOCUMENT_MAX_BYTES)
    throw new DocumentRefusal('too_large', `${bytes.length} bytes`);
  switch (mime) {
    case 'application/pdf':
      return extractPdf(bytes);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return finish(extractDocx(bytes), null);
    case 'text/markdown':
    case 'text/plain':
      return finish(plainText(bytes), null);
    default:
      throw new DocumentRefusal('unsupported_type', mime);
  }
}

function finish(raw: string, pages: number | null): ExtractedDocument {
  const tidy = tidyText(raw);
  if (!tidy) throw new DocumentRefusal('no_text');
  const capped = capText(tidy);
  return { text: capped.text, truncated: capped.truncated, pages };
}

// ---- plain text ----

export function plainText(bytes: Buffer): string {
  if (bytes.includes(0)) throw new DocumentRefusal('unsupported_type', 'binary content');
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  const replaced = (text.match(/\uFFFD/g) ?? []).length;
  if (replaced > Math.max(10, text.length / 100))
    throw new DocumentRefusal('unsupported_type', 'not UTF-8 text');
  return text;
}

// ---- PDF ----

/** The part of pdf.js's document proxy read here (unpdf's published types omit some of it). */
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<{
    getTextContent(): Promise<{ items: unknown[] }>;
    cleanup(): void;
  }>;
  cleanup(): Promise<void> | void;
  loadingTask?: { destroy(): Promise<void> };
}
type PdfLoader = (data: Uint8Array, options: Record<string, unknown>) => Promise<PdfDocument>;
let pdfLoader: Promise<PdfLoader> | null = null;
/** Loaded on first use only: the API and the other workers never load pdf.js. */
const loadPdf = (): Promise<PdfLoader> =>
  (pdfLoader ??= import('unpdf').then((m) => m.getDocumentProxy as unknown as PdfLoader));

export async function extractPdf(bytes: Buffer): Promise<ExtractedDocument> {
  if (bytes.subarray(0, 1024).indexOf('%PDF-') < 0) throw new DocumentRefusal('corrupt', 'not a PDF');
  const getDocumentProxy = await loadPdf();
  let pdf: PdfDocument;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), {
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    });
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    if (/Password/i.test(name)) throw new DocumentRefusal('encrypted');
    throw new DocumentRefusal('corrupt', name || null);
  }
  try {
    const total = pdf.numPages;
    const read = Math.min(total, SOURCE_PDF_MAX_PAGES);
    const parts: string[] = [];
    let chars = 0;
    for (let n = 1; n <= read && chars <= SOURCE_TEXT_MAX_CHARS; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let line = '';
      const lines: string[] = [];
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== 'string') continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = '';
        }
      }
      if (line) lines.push(line);
      const text = lines.join('\n');
      chars += text.length;
      parts.push(text);
      page.cleanup();
    }
    const joined = parts.join('\n\n');
    if (!joined.replace(/\s+/g, '')) throw new DocumentRefusal('scanned_pdf');
    const doc = finish(joined, total);
    return { ...doc, truncated: doc.truncated || read < total };
  } finally {
    await (pdf.loadingTask ? pdf.loadingTask.destroy() : pdf.cleanup());
  }
}

// ---- DOCX (a bounded zip reader: only the entries read are inflated, each with a hard output cap) ----

const ZIP_ENTRY_MAX = 5000;
/** word/document.xml inflates to at most this; beyond it the document is refused as too large. */
const DOCX_XML_MAX_BYTES = 24 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function zipEntries(buf: Buffer): ZipEntry[] {
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new DocumentRefusal('corrupt', 'not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff)
    throw new DocumentRefusal('corrupt', 'zip64 is not supported');
  if (count > ZIP_ENTRY_MAX) throw new DocumentRefusal('too_large', `${count} entries`);
  if (offset + size > buf.length) throw new DocumentRefusal('corrupt', 'truncated zip');
  const out: ZipEntry[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
      throw new DocumentRefusal('corrupt', 'bad zip');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    if (flags & 0x1) throw new DocumentRefusal('encrypted');
    out.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

function readEntry(buf: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50)
    throw new DocumentRefusal('corrupt', 'bad zip entry');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new DocumentRefusal('corrupt', 'truncated zip entry');
  if (entry.method === 0) {
    if (data.length > maxBytes) throw new DocumentRefusal('too_large', entry.name);
    return data;
  }
  if (entry.method !== 8) throw new DocumentRefusal('corrupt', `compression ${entry.method}`);
  try {
    return inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE')
      throw new DocumentRefusal('too_large', `${entry.name} over ${maxBytes} bytes`);
    throw new DocumentRefusal('corrupt', entry.name);
  }
}

/** Word paragraphs as text: headings (Title, Heading 1-6) as `#` lines, list paragraphs as `- ` lines. */
/** WordprocessingML paragraphs as text, read in one pass of the linear markup scanner (no regex over the XML). */
export function docxXmlToText(xml: string): string {
  const out: string[] = [];
  let para: { runs: string; style: string; list: boolean } | null = null;
  let inText = false;
  const endParagraph = () => {
    if (!para) return;
    const text = decodeEntities(para.runs).trim();
    const style = para.style;
    const list = para.list;
    para = null;
    if (!text) {
      out.push('');
      return;
    }
    const heading = /^Title$/i.test(style) ? 1 : Number(/^Heading([1-6])$/i.exec(style)?.[1] ?? 0);
    if (heading) out.push(`\n${'#'.repeat(heading)} ${text}\n`);
    else if (list || /^List/i.test(style)) out.push(`- ${text}`);
    else out.push(text);
  };
  for (const t of scanMarkup(xml, { rawText: false })) {
    if (t.type === 'text') {
      if (para && inText) para.runs += t.text;
      continue;
    }
    if (t.type === 'close') {
      if (t.name === 'w:t') inText = false;
      else if (t.name === 'w:p') endParagraph();
      continue;
    }
    switch (t.name) {
      case 'w:p':
        endParagraph();
        if (t.selfClosing) out.push('');
        else para = { runs: '', style: '', list: false };
        break;
      case 'w:t':
        inText = !t.selfClosing;
        break;
      case 'w:tab':
        if (para) para.runs += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        if (para) para.runs += '\n';
        break;
      case 'w:pstyle':
        if (para && !para.style) para.style = t.attrs.get('w:val') ?? '';
        break;
      case 'w:numpr':
        if (para) para.list = true;
        break;
    }
  }
  endParagraph();
  return out.join('\n');
}

export function extractDocx(bytes: Buffer): string {
  const entries = zipEntries(bytes);
  const main = entries.find((e) => e.name === 'word/document.xml');
  if (!main) throw new DocumentRefusal('unsupported_type', 'not a Word document');
  const xml = readEntry(bytes, main, DOCX_XML_MAX_BYTES).toString('utf8');
  return docxXmlToText(xml);
}
