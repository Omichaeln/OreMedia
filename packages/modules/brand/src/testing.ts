import { deflateRawSync } from 'node:zlib';

/**
 * Test fixtures for BSC-4 document extraction, built byte by byte so tests carry no binary files: a minimal PDF with
 * a text layer (or none: a "scanned" page), a minimal Word .docx (headings, list items, paragraphs) and a zip whose
 * document inflates past the cap. Imported by tests only (`@oremedia/module-brand/testing`).
 */
export function pdfWithText(lines: readonly string[], opts: { text?: boolean } = {}): Buffer {
  const escape = (l: string) => l.replace(/[\\()]/g, (c) => `\\${c}`);
  const content =
    opts.text === false
      ? '0 0 1 rg 72 72 200 200 re f'
      : `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${escape(l)}) Tj`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export interface ZipEntryInput {
  name: string;
  data: Buffer;
  /** 0 stored, 8 deflate (the default). */
  method?: 0 | 8;
}

/** A zip archive (no data descriptors, no zip64): what Word writes, minus what readers need not check. */
export function zip(entries: readonly ZipEntryInput[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(e.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += header.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dir, end]);
}

export type DocxParagraph = string | { text: string; style?: string; list?: boolean };

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A minimal Word document: one paragraph per entry, with an optional style (Title, Heading1...) or list numbering. */
export function docx(paragraphs: readonly DocxParagraph[]): Buffer {
  const body = paragraphs
    .map((p) => {
      const { text, style, list } = typeof p === 'string' ? { text: p, style: undefined, list: false } : p;
      const props =
        style || list
          ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}</w:pPr>`
          : '';
      return `<w:p>${props}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
    })
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/document.xml', data: Buffer.from(xml, 'utf8') },
  ]);
}

/** A .docx whose document.xml inflates to `bytes` (a few KB compressed): stopped at the reader's cap. */
export function docxBomb(bytes = 40 * 1024 * 1024): Buffer {
  return zip([{ name: 'word/document.xml', data: Buffer.alloc(bytes, 0x20) }]);
}
