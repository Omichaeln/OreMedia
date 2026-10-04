import { describe, expect, it } from 'vitest';
import { SOURCE_TEXT_MAX_CHARS } from '@oremedia/contracts/brand-assist';
import { docx, docxBomb, pdfWithText, zip } from '../testing';
import { DocumentRefusal, capText, docxXmlToText, extractDocument } from './documents';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if (err instanceof DocumentRefusal) return err.reason;
    throw err;
  }
  throw new Error('expected a refusal');
};

describe('document text extraction (BSC-4)', () => {
  it('reads the text layer of a PDF, page count included', async () => {
    const out = await extractDocument(
      pdfWithText(['Ore Roasters brand guide', 'We write (plainly).']),
      'application/pdf',
    );
    expect(out).toEqual({
      text: 'Ore Roasters brand guide\nWe write (plainly).',
      truncated: false,
      pages: 1,
    });
  });

  it('a PDF without a text layer is a scanned PDF; something else named PDF is corrupt', async () => {
    expect(await refusal(extractDocument(pdfWithText([], { text: false }), 'application/pdf'))).toBe(
      'scanned_pdf',
    );
    expect(await refusal(extractDocument(Buffer.from('hello'), 'application/pdf'))).toBe('corrupt');
  });

  it('reads a Word document: headings as # lines, list paragraphs as - lines', async () => {
    const out = await extractDocument(
      docx([
        { text: 'Brand voice', style: 'Title' },
        { text: 'Principles', style: 'Heading2' },
        { text: 'Say what it does', list: true },
        'We write for people in a hurry & we respect them.',
      ]),
      DOCX,
    );
    expect(out.text).toBe(
      '# Brand voice\n\n## Principles\n\n- Say what it does\nWe write for people in a hurry & we respect them.',
    );
  });

  it('stops a zip bomb at the cap; refuses a zip without a Word document and garbage', async () => {
    expect(await refusal(extractDocument(docxBomb(), DOCX))).toBe('too_large');
    expect(await refusal(extractDocument(zip([{ name: 'a.txt', data: Buffer.from('x') }]), DOCX))).toBe(
      'unsupported_type',
    );
    expect(await refusal(extractDocument(Buffer.from('not a zip at all'), DOCX))).toBe('corrupt');
  });

  it('reads Markdown and text as UTF-8; refuses binary content and empty text', async () => {
    expect((await extractDocument(Buffer.from('﻿# Voice\r\n\r\nPlain.'), 'text/markdown')).text).toBe(
      '# Voice\n\nPlain.',
    );
    expect(await refusal(extractDocument(Buffer.from([0x50, 0, 0x51]), 'text/plain'))).toBe(
      'unsupported_type',
    );
    expect(await refusal(extractDocument(Buffer.from('  \n '), 'text/plain'))).toBe('no_text');
  });

  it('caps text without splitting a surrogate pair and says it was cut', () => {
    const long = `${'a'.repeat(SOURCE_TEXT_MAX_CHARS - 1)}😀tail`;
    const out = capText(long);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(SOURCE_TEXT_MAX_CHARS - 1);
  });

  it('docx paragraphs keep tabs and breaks', () => {
    expect(
      docxXmlToText(
        '<w:body><w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p></w:body>',
      ),
    ).toBe('a\tb\nc');
  });
});

describe('docxXmlToText on hostile XML (BSC-4)', () => {
  const N = 20_000;
  it.each([
    ['unclosed paragraphs', '<w:p>'.repeat(N)],
    ['paragraph tags without ends', '<w:p '.repeat(N)],
    ['unclosed text runs', '<w:p><w:t>'.repeat(N)],
  ])('stays linear on %s', (_, xml) => {
    const started = performance.now();
    docxXmlToText(`<w:document><w:body>${xml}</w:body></w:document>`);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
