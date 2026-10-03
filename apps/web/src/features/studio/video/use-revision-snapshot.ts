import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../../../lib/trpc';

/** An earlier revision of a video, to restore: its timeline and number (null until a revision is chosen). */
export function useRevisionSnapshot(documentId: string, revisionId: string | null) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.creative.revisions.get.queryOptions({ documentId, revisionId: revisionId ?? '' }),
    enabled: revisionId !== null,
    select: (rev) => (rev.kind === 'video' ? { snapshot: rev.snapshot, number: rev.number } : null),
  });
}
