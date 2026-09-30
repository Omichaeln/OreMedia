import { NotFoundError } from '@oremedia/contracts/errors';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import type { Tx } from '@oremedia/db';
import { contentService } from './service';

/** The run facts the generic tool code passes with every call (the brand, the run id recorded, the mode). */
interface RunRef {
  brandId: string;
  runId: string;
  autonomyMode: AutonomyMode;
}

/** The first line of the caption as a package title (the studio lists packages by title). */
const titleOf = (text: string, index: number, count: number) => {
  const first = text.trim().split('\n')[0]?.trim() ?? '';
  const base = (first || 'Drafted copy').slice(0, 180);
  return count > 1 ? `${base} (variant ${index + 1})` : base;
};

/**
 * Spec 12.4 content.createBrief / content.draftCopy: what the generic tools in @oremedia/ai reach when this module
 * is composed (registerContentToolSource, structurally the ContentToolSource there). Every method runs as the run's
 * service principal under the run's autonomy mode inside the tool's transaction; the content commands assert policy,
 * bind every id to the run's brand (another brand's or tenant's id is NOT_FOUND) and record the run id.
 */
export const contentToolSource = {
  async createBrief(
    actor: ResolvedActorServicePrincipal,
    input: RunRef & {
      campaignId?: string;
      audience: string;
      message: string;
      offerFactIds: string[];
      channelConnectionIds: string[];
      constraints: string[];
    },
    tx: Tx,
  ): Promise<{ briefId: string }> {
    const { runId, autonomyMode, ...brief } = input;
    const created = await contentService.briefs.create(actor, brief, tx, { autonomyMode, agentRunId: runId });
    return { briefId: created.briefId };
  },

  /** One draft package per variant under the brief, each born with revision 1 carrying the copy and its facts. */
  async draftCopy(
    actor: ResolvedActorServicePrincipal,
    input: RunRef & {
      briefId: string;
      variants: Array<{ text: string; factIds: string[]; rationale: string }>;
    },
    tx: Tx,
  ): Promise<{
    drafts: Array<{ contentPackageId: string; contentRevisionId: string; contentHash: string }>;
  }> {
    const drafts = [];
    for (const [i, variant] of input.variants.entries()) {
      const created = await contentService.packages.create(
        actor,
        {
          brandId: input.brandId,
          briefId: input.briefId, // bound to the brand: another brand's or tenant's brief is NOT_FOUND
          title: titleOf(variant.text, i, input.variants.length),
          copy: {
            schemaVersion: 1,
            master: { text: variant.text, factRefs: variant.factIds },
            rationale: variant.rationale,
          },
        },
        tx,
        { autonomyMode: input.autonomyMode, agentRunId: input.runId },
      );
      drafts.push({
        contentPackageId: created.contentPackageId,
        contentRevisionId: created.contentRevisionId,
        contentHash: created.contentHash,
      });
    }
    return { drafts };
  },

  /** UX-09: the run's calendar becomes plan items of its brief (bound to the brand), recorded against the run. */
  async proposePlan(
    actor: ResolvedActorServicePrincipal,
    input: RunRef & {
      briefId: string;
      items: Array<{ date: string; channelKey: string; theme: string; formatKey: string; factIds: string[] }>;
    },
    tx: Tx,
  ): Promise<{ briefId: string; planItemIds: string[] }> {
    const { runId, autonomyMode, brandId, ...plan } = input;
    const brief = await contentService.briefs.get(actor, { briefId: plan.briefId }, tx);
    if (brief.brandId !== brandId) throw new NotFoundError('Brief', plan.briefId); // the run's brand binds
    return contentService.planItems.propose(actor, plan, tx, { autonomyMode, agentRunId: runId });
  },
};
