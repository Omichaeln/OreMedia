import { z } from 'zod';

/** Spec 13.2: approval binds to exactly what was approved. Hash = sha256(canonicalJson(binding)). */
export const ApprovalBindingV1 = z.object({
  v: z.literal(1),
  tenantId: z.string(),
  brandId: z.string(),
  contentRevisionId: z.string(),
  brandVersionId: z.string(),
  policyVersionId: z.string(),
  targets: z
    .array(
      z
        .object({
          /** The channel, or (R2-3) the brand destination; exactly one is set. A binding written before destinations existed names a channel. */
          channelConnectionId: z.string().optional(),
          destinationId: z.string().optional(),
          textHash: z.string(), // exact caption, normalised (NFC, trimmed trailing whitespace)
          altTextHashes: z.array(z.string()),
          settingsHash: z.string(), // provider settings, canonical JSON
          exportHashes: z.array(z.string()), // exact rendered files, in order
        })
        .refine((t) => !!t.channelConnectionId !== !!t.destinationId, {
          message: 'exactly one of channelConnectionId or destinationId',
        }),
    )
    .min(1),
  timing: z.union([
    z.object({ kind: z.literal('exact'), at: z.string().datetime() }),
    z.object({ kind: z.literal('window'), from: z.string().datetime(), to: z.string().datetime() }),
  ]),
});
export type ApprovalBindingV1 = z.infer<typeof ApprovalBindingV1>;

/** A bound target's identity: the destination when the target is one, else the channel. */
export const bindingTargetId = (t: { channelConnectionId?: string; destinationId?: string }): string =>
  t.destinationId ?? t.channelConnectionId ?? '';

export const ApprovalState = z.enum(['valid', 'invalidated', 'consumed', 'expired']);
export type ApprovalState = z.infer<typeof ApprovalState>;
