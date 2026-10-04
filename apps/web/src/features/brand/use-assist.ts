import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferOutput } from '@trpc/tanstack-react-query';
import {
  ASSIST_TERMINAL_STATES,
  SOURCE_DOCUMENT_TYPES,
  type AssistSection,
  type BrandAssistRequest,
  type SourceDocumentMime,
  type SuggestionStatus,
} from '@oremedia/contracts/brand-assist';
import { intentContext, newIntentKey } from '../../lib/intent-key';
import { useTRPC, useTRPCClient, type Trpc } from '../../lib/trpc';

export type BrandSourceDto = inferOutput<Trpc['brand']['sources']['list']>['items'][number];
export type AssistJobDto = inferOutput<Trpc['brand']['assist']['get']>;
export type SuggestionDto = inferOutput<Trpc['brand']['suggestions']['list']>['items'][number];
export type AssistEstimateDto = inferOutput<Trpc['brand']['assist']['estimate']>;
export type HistoryEntryDto = inferOutput<Trpc['brand']['history']['list']>['items'][number];
export type HistoryCompareDto = inferOutput<Trpc['brand']['history']['compare']>;

/** How often a running job and the sources it reads are read again while it works. */
const JOB_POLL_MS = 2_000;
const isRunning = (state: string | undefined) =>
  state !== undefined && !ASSIST_TERMINAL_STATES.includes(state as never);

/** BSC-4: the brand's sources (statuses refresh while any is still waiting to be read). */
export function useBrandSources(brandId: string, polling = false) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.brand.sources.list.queryOptions({ brandId, page: { limit: 50 } }),
    refetchInterval: polling ? JOB_POLL_MS : false,
  });
}

/** One source with the start of its text (to read an excerpt in context). */
export function useBrandSource(brandId: string, sourceId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.brand.sources.get.queryOptions({ brandId, sourceId: sourceId ?? '' }),
    enabled: sourceId !== null,
  });
}

/** The brand's assist jobs, newest first. */
export function useAssistJobs(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.brand.assist.list.queryOptions({ brandId, page: { limit: 20 } }));
}

/** One job, read every two seconds until it reaches a final state. */
export function useAssistJob(brandId: string, jobId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.brand.assist.get.queryOptions({ brandId, jobId: jobId ?? '' }),
    enabled: jobId !== null,
    refetchInterval: (q) => (isRunning(q.state.data?.state) ? JOB_POLL_MS : false),
  });
}

/** What a job would cost and what would stop it, read before it starts. */
export function useAssistEstimate(request: BrandAssistRequest | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.brand.assist.estimate.queryOptions(
      request ?? { brandId: '', kind: 'section', sections: ['voice'], sourceIds: [] },
    ),
    enabled: request !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
}

export interface SuggestionFilter {
  jobId?: string;
  section?: AssistSection;
  status?: SuggestionStatus;
}

/** Suggestions of a job (or of the brand), oldest first within a job, as the model gave them. */
export function useSuggestions(brandId: string, filter: SuggestionFilter, enabled = true, polling = false) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.brand.suggestions.list.queryOptions({ brandId, ...filter, page: { limit: 200 } }),
    enabled,
    refetchInterval: polling ? JOB_POLL_MS : false,
    placeholderData: keepPreviousData,
  });
}

/** BSC-5: the applied versions of the brand system, newest first. */
export function useBrandHistory(brandId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.brand.history.list.queryOptions({ brandId, page: { limit: 50 } }));
}

/** What differs between an applied version and the brand system now, per section. */
export function useHistoryCompare(brandId: string, versionId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.brand.history.compare.queryOptions({ brandId, versionId: versionId ?? '' }),
    enabled: versionId !== null,
  });
}

/** The MIME type a file is uploaded as: what the browser says, else its extension. */
export function documentMimeOf(file: File): SourceDocumentMime | null {
  const known = Object.keys(SOURCE_DOCUMENT_TYPES) as SourceDocumentMime[];
  if (known.includes(file.type as SourceDocumentMime)) return file.type as SourceDocumentMime;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext === 'pdf'
    ? 'application/pdf'
    : ext === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : ext === 'md' || ext === 'markdown'
        ? 'text/markdown'
        : ext === 'txt'
          ? 'text/plain'
          : null;
}

/**
 * A document source: the source is recorded, then the file goes to the signed upload address; its text is read when
 * a job starts. Every call is its own intent (one idempotency key per file).
 */
export function useDocumentSourceUpload(brandId: string) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const mime = documentMimeOf(file);
      if (!mime) throw new Error(`${file.name}: only PDF, Word (.docx), Markdown and text files can be read`);
      const added = await client.brand.sources.add.mutate(
        { kind: 'document', brandId, fileName: file.name, mime, byteSize: file.size },
        intentContext(newIntentKey()),
      );
      if (added.upload) {
        const put = await fetch(added.upload.url, {
          method: 'PUT',
          body: file,
          headers: { 'content-type': added.upload.contentType },
        });
        if (!put.ok) throw new Error(`${file.name}: the upload failed (HTTP ${put.status})`);
      }
      return added;
    },
    onSettled: () => void queryClient.invalidateQueries(trpc.brand.sources.pathFilter()),
  });
}
