import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { BrandSourceReason } from '@oremedia/contracts/brand-assist';
import { DocumentRefusal, type ExtractedDocument } from './documents';
import type { PageText } from './html-text';

/**
 * BSC-4: untrusted pages and documents are parsed off the activity's thread, in a worker thread with a memory ceiling
 * (resourceLimits) and a hard timer. Whatever a crafted page or file does to the parser (pathological markup, a PDF
 * that loops or balloons), the worker is terminated and the source is refused with `processing_limit`; the activity,
 * its heartbeats and the other sources carry on. One worker serves one crawl or one document, a job at a time, and is
 * replaced after it is stopped.
 *
 * The worker script is capture/worker.ts. Run from sources (tests, `tsx` in development) it is loaded through tsx's
 * API; in a bundled worker app it is the `capture-worker.js` entry each app's tsup config emits next to its bundle.
 */
export type IsolatedJob =
  { kind: 'html'; html: string; pageUrl: string } | { kind: 'document'; bytes: Uint8Array; mime: string };

export type IsolatedReply =
  | { ok: true; value: PageText | ExtractedDocument }
  | { ok: false; refusal: { reason: BrandSourceReason; detail: string | null } }
  | { ok: false; error: string };

export interface IsolateOptions {
  /** Longest a page may take to parse. */
  pageTimeoutMs?: number;
  /** Longest a document may take to extract. */
  documentTimeoutMs?: number;
  /** The worker's V8 old-generation ceiling. */
  maxMemoryMb?: number;
}

export const PAGE_PARSE_TIMEOUT_MS = 10_000;
export const DOCUMENT_PARSE_TIMEOUT_MS = 90_000;
export const PARSE_MAX_MEMORY_MB = 512;
const HEAP_SAMPLE_MS = 100;

export interface CaptureIsolate {
  pageText(html: string, pageUrl: string): Promise<PageText>;
  /** Throws DocumentRefusal (`processing_limit` included) as extractDocument does. */
  extract(bytes: Buffer, mime: string): Promise<ExtractedDocument>;
  close(): Promise<void>;
}

/** Parsing was stopped (time or memory); the source or page is refused with `processing_limit`. */
export class ProcessingLimitError extends DocumentRefusal {
  constructor(detail: string) {
    super('processing_limit', detail);
    this.name = 'ProcessingLimitError';
  }
}

/**
 * The worker to start: the bundled `capture-worker.js` next to this module, or, run from sources, worker.ts loaded
 * through tsx's ESM API (a worker thread does not inherit `--import tsx` loader hooks).
 */
function workerScript(): { script: URL | string; eval: boolean } {
  const here = import.meta.url;
  if (!here.endsWith('.ts')) return { script: new URL('./capture-worker.js', here), eval: false };
  const source = new URL('./worker.ts', here).href;
  const pkgPath = createRequire(here).resolve('tsx/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    exports: { './esm/api': { import: { default: string } } };
  };
  const api = new URL(pkg.exports['./esm/api'].import.default, pathToFileURL(pkgPath)).href;
  const code = `import(${JSON.stringify(api)}).then((m) => m.tsImport(${JSON.stringify(source)}, ${JSON.stringify(source)}));`;
  return { script: code, eval: true };
}

export function createCaptureIsolate(opts: IsolateOptions = {}): CaptureIsolate {
  let worker: Worker | null = null;
  let seq = 0;
  const memoryMb = opts.maxMemoryMb ?? PARSE_MAX_MEMORY_MB;

  const start = (): Worker => {
    const script = workerScript();
    const w = new Worker(script.script, {
      eval: script.eval,
      resourceLimits: {
        maxOldGenerationSizeMb: memoryMb,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 4,
      },
      env: {},
      stdout: false,
      stderr: false,
    });
    w.unref();
    return w;
  };

  const stop = async () => {
    const w = worker;
    worker = null;
    if (w) await w.terminate().catch(() => 0);
  };

  const run = (job: IsolatedJob, timeoutMs: number, transfer: ArrayBuffer[] = []) =>
    new Promise<PageText | ExtractedDocument>((resolve, reject) => {
      const w = (worker ??= start());
      const id = ++seq;
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(watch);
        w.off('message', onMessage);
        w.off('error', onError);
        w.off('exit', onExit);
      };
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        void stop();
        reject(err);
      };
      const timer = setTimeout(
        () => fail(new ProcessingLimitError(`stopped after ${Math.round(timeoutMs / 1000)} s`)),
        timeoutMs,
      );
      // resourceLimits is the ceiling, but a process-wide --max-old-space-size (NODE_OPTIONS) overrides it in worker
      // threads; the heap is therefore also sampled while the job runs (an interrupt, so a busy parser still answers).
      const watch = setInterval(() => {
        void w
          .getHeapStatistics()
          .then((h) => {
            if (h.used_heap_size > memoryMb * 1024 * 1024)
              fail(new ProcessingLimitError('stopped at the memory limit'));
          })
          .catch(() => {});
      }, HEAP_SAMPLE_MS);
      const onMessage = (reply: IsolatedReply & { id: number }) => {
        if (reply.id !== id || settled) return;
        settled = true;
        cleanup();
        if (reply.ok) resolve(reply.value);
        else if ('refusal' in reply) reject(new DocumentRefusal(reply.refusal.reason, reply.refusal.detail));
        else reject(new Error(`capture worker: ${reply.error}`));
      };
      const onError = (err: Error & { code?: string }) =>
        fail(
          err.code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? new ProcessingLimitError('stopped at the memory limit')
            : new Error(`capture worker: ${err.message}`),
        );
      const onExit = (code: number) =>
        fail(new ProcessingLimitError(`the parser stopped unexpectedly (${code})`));
      w.on('message', onMessage);
      w.on('error', onError);
      w.on('exit', onExit);
      w.postMessage({ id, job }, transfer);
    });

  return {
    async pageText(html, pageUrl) {
      return (await run(
        { kind: 'html', html, pageUrl },
        opts.pageTimeoutMs ?? PAGE_PARSE_TIMEOUT_MS,
      )) as PageText;
    },
    async extract(bytes, mime) {
      // A copy the worker owns (transferred, not cloned twice); the caller keeps its buffer.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return (await run(
        { kind: 'document', bytes: copy, mime },
        opts.documentTimeoutMs ?? DOCUMENT_PARSE_TIMEOUT_MS,
        [copy.buffer],
      )) as ExtractedDocument;
    },
    close: stop,
  };
}
