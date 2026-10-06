import type { ReportDrafterV1 } from '@oremedia/contracts/reports';

/**
 * The model gateway a report drafts through, as @oremedia/ai provides it (composition wires
 * `reportDrafterFromEnv()`, the same adapter and routing policy brand assist and the agents read). There is no
 * harmless default: until registered, a draft reports `model_unavailable` and the summary stays a text field.
 */
let drafter: ReportDrafterV1 | null = null;
export const registerReportDrafter = (d: ReportDrafterV1 | null): void => {
  drafter = d;
};
export const reportDrafter = (): ReportDrafterV1 | null => drafter;
