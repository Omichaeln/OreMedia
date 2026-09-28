import type { BrandClassification } from '@oremedia/contracts/brand';

/** D-11: what each brand type means for approvals, as the create form and the settings row say it. */
export const CLASSIFICATION_LABEL: Record<BrandClassification, { label: string; hint: string }> = {
  client: {
    label: 'Client brand',
    hint: 'Content needs an approver other than its author, unless the release policy says otherwise.',
  },
  internal: {
    label: 'Internal brand',
    hint: 'An author may approve their own content, unless the release policy requires a distinct approver.',
  },
};
