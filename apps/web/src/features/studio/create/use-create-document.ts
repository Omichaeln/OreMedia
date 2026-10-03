import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { inferInput } from '@trpc/tanstack-react-query';
import { brandPath, useBrandContext } from '../../brand/brand-context';
import { useTRPC, useTRPCClient, type Trpc } from '../../../lib/trpc';
import { intentContext, newIntentKey } from '../../../lib/intent-key';

export type CreateInput = inferInput<Trpc['creative']['documents']['create']>;
export type DuplicateInput = inferInput<Trpc['creative']['documents']['duplicate']>;
export type StartRequest =
  { kind: 'create'; input: CreateInput } | { kind: 'duplicate'; input: DuplicateInput };

/**
 * STU-1a: one mutation for every way of starting a document (create from a starter, a template, blank, a custom size,
 * or duplicate). Each start is its own intent (a fresh idempotency key); on success the studio opens on the new
 * document, so choosing a start is the only step.
 */
export function useStartDocument() {
  const { companyId, brandId } = useBrandContext();
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (req: StartRequest) => {
      const ctx = intentContext(newIntentKey());
      return req.kind === 'create'
        ? client.creative.documents.create.mutate(req.input, ctx)
        : client.creative.documents.duplicate.mutate(req.input, ctx);
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries(trpc.creative.documents.pathFilter());
      navigate(brandPath(companyId, brandId, `studio/${encodeURIComponent(res.documentId)}`));
    },
  });
}
