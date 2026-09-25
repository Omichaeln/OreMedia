import { describe, expect, it } from 'vitest';
import { classifyReviewMessage } from './main';

describe('provider review message classification', () => {
  it('maps LinkedIn approval email to the LinkedIn Page provider', () => {
    expect(
      classifyReviewMessage({
        sender: 'LinkedIn Developer Support <noreply@linkedin.com>',
        subject: 'Your Community Management API application was approved',
        snippet: 'Your request has been approved.',
      }),
    ).toMatchObject({ status: 'approved', providerGroup: 'linkedin' });
  });

  it('maps Meta approval email to both Facebook and Instagram providers', () => {
    expect(
      classifyReviewMessage({
        sender: 'Meta for Developers <platform@facebookmail.com>',
        subject: 'Your app review is approved for Live Mode',
        snippet: 'Your app can now use the approved permissions.',
      }),
    ).toMatchObject({ status: 'approved', providerGroup: 'meta' });
  });

  it('does not mistake a rejection sentence containing approved for approval', () => {
    expect(
      classifyReviewMessage({
        sender: 'Meta for Developers <platform@facebookmail.com>',
        subject: 'Your app was not approved',
        snippet: 'The requested permissions were not approved.',
      }),
    ).toMatchObject({ status: 'rejected', providerGroup: 'meta' });
  });

  it('recognizes action-required messages', () => {
    expect(
      classifyReviewMessage({
        sender: 'LinkedIn <noreply@linkedin.com>',
        subject: 'Action required for your application',
        snippet: 'More information required before we can review it.',
      }),
    ).toMatchObject({ status: 'action_required', providerGroup: 'linkedin' });
  });

  it('ignores unrelated mail', () => {
    expect(
      classifyReviewMessage({ sender: 'alerts@example.com', subject: 'Build complete', snippet: 'Deployment succeeded.' }),
    ).toBeNull();
  });
});
