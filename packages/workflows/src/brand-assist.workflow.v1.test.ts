import { describe, expect, it } from 'vitest';
import type {
  BrandAssistActivitiesV1,
  BrandAssistInputV1,
  BrandSourceCaptureActivitiesV1,
  BrandSourceExtractActivitiesV1,
} from '@oremedia/contracts/brand-assist';
import { runBrandAssist } from './brand-assist.workflow.v1';

const input: BrandAssistInputV1 = {
  tenantId: 'ten_a',
  actor: { kind: 'user', id: 'usr_1' },
  correlationId: 'c',
  brandId: 'brd_1',
  jobId: 'baj_1',
};

function fakes(
  over: Partial<BrandAssistActivitiesV1> = {},
  opts: { failCapture?: string; failSection?: string } = {},
) {
  const calls: string[] = [];
  const acts: BrandAssistActivitiesV1 = {
    beginBrandAssist: async () => {
      calls.push('begin');
      return {
        outcome: 'run',
        reason: null,
        urlSourceIds: ['s_url'],
        documentSourceIds: ['s_doc'],
        sections: ['voice', 'facts'],
      };
    },
    markBrandAssistStage: async (i) => void calls.push(`stage:${i.stage}`),
    recordBrandSourceFailure: async (i) => void calls.push(`source-failed:${i.sourceId}:${i.reason}`),
    prepareBrandAssistProposals: async () => {
      calls.push('prepare');
      return { outcome: 'run', reason: null, sections: ['voice', 'facts'] };
    },
    proposeBrandAssistSection: async (i) => {
      calls.push(`propose:${i.section}`);
      if (i.section === opts.failSection)
        throw Object.assign(new Error('provider down'), { type: undefined });
      return { section: i.section, outcome: 'ready', suggestions: 2, reason: null };
    },
    recordBrandAssistSectionFailure: async (i) => void calls.push(`section-failed:${i.section}:${i.reason}`),
    finishBrandAssist: async (i) => {
      calls.push(`finish:${i.cancelled}:${i.failure}`);
      return { state: 'ready', suggestions: 4 };
    },
    ...over,
  };
  const capture: BrandSourceCaptureActivitiesV1 = {
    captureBrandSourceUrl: async (i) => {
      calls.push(`capture:${i.sourceId}`);
      if (i.sourceId === opts.failCapture) throw new Error('crashed');
      return { sourceId: i.sourceId, status: 'captured', reason: null };
    },
  };
  const extract: BrandSourceExtractActivitiesV1 = {
    extractBrandSourceDocument: async (i) => {
      calls.push(`extract:${i.sourceId}`);
      return { sourceId: i.sourceId, status: 'captured', reason: null };
    },
  };
  return { acts, capture, extract, calls };
}
const host = (cancelAfter?: number) => {
  let n = 0;
  return {
    cancelled: () => cancelAfter !== undefined && ++n > cancelAfter,
    nonCancellable: <T>(fn: () => Promise<T>) => fn(),
  };
};

describe('brandAssistWorkflowV1 orchestration (BSC-4)', () => {
  it('captures websites, then extracts documents, then reserves and proposes per section, then closes the job', async () => {
    const f = fakes();
    await runBrandAssist(f.acts, f.capture, f.extract, input, host());
    expect(f.calls).toEqual([
      'begin',
      'capture:s_url',
      'stage:extracting',
      'extract:s_doc',
      'prepare',
      'propose:voice',
      'propose:facts',
      'finish:false:null',
    ]);
  });

  it('a source that keeps failing is recorded and the job goes on; a failing section fails alone', async () => {
    const f = fakes({}, { failCapture: 's_url', failSection: 'voice' });
    await runBrandAssist(f.acts, f.capture, f.extract, input, host());
    expect(f.calls).toContain('source-failed:s_url:capture_failed');
    expect(f.calls).toContain('section-failed:voice:model_failed');
    expect(f.calls.slice(-2)).toEqual(['propose:facts', 'finish:false:null']);
  });

  it('a refused preparation (budget, gates) proposes nothing and closes the job with the reason', async () => {
    const f = fakes({
      prepareBrandAssistProposals: async () => ({
        outcome: 'failed',
        reason: 'budget_exhausted',
        sections: [],
      }),
    });
    await runBrandAssist(f.acts, f.capture, f.extract, input, host());
    expect(f.calls.filter((c) => c.startsWith('propose'))).toEqual([]);
    expect(f.calls.at(-1)).toBe('finish:false:budget_exhausted');
  });

  it('a cancel stops before the next step and the job is still closed (as cancelled)', async () => {
    const f = fakes();
    await runBrandAssist(f.acts, f.capture, f.extract, input, host(1));
    expect(f.calls).toEqual(['begin', 'capture:s_url', 'finish:true:null']);
  });

  it('a job already finished or cancelled before it began is only closed', async () => {
    const f = fakes({
      beginBrandAssist: async () => ({
        outcome: 'skipped',
        reason: 'cancelled',
        urlSourceIds: [],
        documentSourceIds: [],
        sections: [],
      }),
    });
    await runBrandAssist(f.acts, f.capture, f.extract, input, host());
    expect(f.calls).toEqual(['finish:true:null']);
  });

  it('a failure the job cannot get past (the person lost access) still closes it, with the reason', async () => {
    const f = fakes({
      beginBrandAssist: async () => {
        throw Object.assign(new Error('denied'), { type: 'PolicyDenied' });
      },
    });
    await runBrandAssist(f.acts, f.capture, f.extract, input, host());
    expect(f.calls).toEqual(['finish:false:not_allowed']);
  });
});
