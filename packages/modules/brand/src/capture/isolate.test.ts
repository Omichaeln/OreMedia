import { afterEach, describe, expect, it } from 'vitest';
import { docx } from '../testing';
import { DocumentRefusal } from './documents';
import { ProcessingLimitError, createCaptureIsolate, type CaptureIsolate } from './isolate';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
let isolate: CaptureIsolate | null = null;
afterEach(async () => {
  await isolate?.close();
  isolate = null;
});

describe('capture isolate (BSC-4)', () => {
  it('parses pages and documents in a worker thread, refusals included, one worker for many jobs', async () => {
    isolate = createCaptureIsolate();
    const page = await isolate.pageText('<title>T</title><main><h2>Hi</h2></main>', 'https://ore.example/');
    expect(page).toMatchObject({ title: 'T', text: '## Hi' });
    const doc = await isolate.extract(docx([{ text: 'Plain words.' }]), DOCX);
    expect(doc.text).toBe('Plain words.');
    const refused = await isolate.extract(Buffer.from('not a zip'), DOCX).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DocumentRefusal);
    expect((refused as DocumentRefusal).reason).toBe('corrupt');
  }, 30_000);

  it('stops a parse that runs past its time and refuses it with processing_limit; the next job gets a new worker', async () => {
    isolate = createCaptureIsolate({ pageTimeoutMs: 1 });
    const err = await isolate.pageText('<p>x</p>', 'https://ore.example/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessingLimitError);
    expect((err as ProcessingLimitError).reason).toBe('processing_limit');
    await isolate.close();
    isolate = createCaptureIsolate();
    await expect(isolate.pageText('<p>again</p>', 'https://ore.example/')).resolves.toMatchObject({
      text: 'again',
    });
  }, 30_000);

  it('stops a parse that exceeds its memory ceiling', async () => {
    isolate = createCaptureIsolate({ maxMemoryMb: 48, pageTimeoutMs: 20_000 });
    const huge = '<li>word '.repeat(3_000_000);
    const err = await isolate.pageText(huge, 'https://ore.example/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessingLimitError);
  }, 30_000);
});
