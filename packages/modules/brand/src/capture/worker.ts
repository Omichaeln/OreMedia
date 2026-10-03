import { parentPort } from 'node:worker_threads';
import { DocumentRefusal, extractDocument } from './documents';
import { htmlToText } from './html-text';
import type { IsolatedJob, IsolatedReply } from './isolate';

/**
 * BSC-4: the worker thread untrusted pages and documents are parsed in (capture/isolate.ts starts it with memory
 * limits and stops it on a timer). It only parses: no I/O, no database, no secrets; one job at a time.
 */
const port = parentPort;
if (!port) throw new Error('capture worker must run in a worker thread');

port.on('message', (message: { id: number; job: IsolatedJob }) => {
  void run(message.job).then((reply) => port.postMessage({ id: message.id, ...reply }));
});

async function run(job: IsolatedJob): Promise<IsolatedReply> {
  try {
    if (job.kind === 'html') return { ok: true, value: htmlToText(job.html, job.pageUrl) };
    return { ok: true, value: await extractDocument(Buffer.from(job.bytes), job.mime) };
  } catch (err) {
    if (err instanceof DocumentRefusal)
      return { ok: false, refusal: { reason: err.reason, detail: err.detail } };
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : 'parse failed' };
  }
}
