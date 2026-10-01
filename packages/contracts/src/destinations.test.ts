import { describe, expect, it } from 'vitest';
import { DESTINATION_KIND_CAPABILITIES, DestinationKind, sourceUseIssues } from './destinations';

describe("sourceUseIssues (D-17: a policy within the kind's capabilities)", () => {
  it('accepts every use a kind offers, and nothing more', () => {
    for (const kind of DestinationKind.options) {
      const uses = DESTINATION_KIND_CAPABILITIES[kind].uses;
      expect(sourceUseIssues(kind, uses, uses.includes('retain') ? 30 : null)).toEqual([]);
    }
  });
  it('a Business Profile location never retains or writes; a webhook never reads', () => {
    expect(sourceUseIssues('gbp_location', ['read', 'write'], null)).toEqual([
      { path: 'allowedUses', issue: 'write_not_supported_by_gbp_location' },
    ]);
    expect(sourceUseIssues('gbp_location', ['retain'], 10)).toEqual([
      { path: 'allowedUses', issue: 'retain_not_supported_by_gbp_location' },
    ]);
    expect(sourceUseIssues('discord_webhook', ['read', 'write', 'read'], null)).toEqual([
      { path: 'allowedUses', issue: 'read_not_supported_by_discord_webhook' },
    ]);
  });
  it('retain needs a retention period; without retain the period is not required', () => {
    expect(sourceUseIssues('ga4_property', ['read', 'retain'], null)).toEqual([
      { path: 'retentionDays', issue: 'required_for_retain' },
    ]);
    expect(sourceUseIssues('ga4_property', ['read', 'retain'], 0)).toEqual([
      { path: 'retentionDays', issue: 'required_for_retain' },
    ]);
    expect(sourceUseIssues('ga4_property', ['read', 'retain'], 90)).toEqual([]);
    expect(sourceUseIssues('ga4_property', ['read'], null)).toEqual([]);
  });
  it('reports both rules at once', () => {
    expect(sourceUseIssues('gbp_location', ['retain', 'write'], null)).toEqual([
      { path: 'allowedUses', issue: 'retain_not_supported_by_gbp_location' },
      { path: 'allowedUses', issue: 'write_not_supported_by_gbp_location' },
      { path: 'retentionDays', issue: 'required_for_retain' },
    ]);
  });
  it('a website may retain its audit runs (R2-4, cms.audit) for a stated period', () => {
    expect(sourceUseIssues('cms_site', ['read', 'retain', 'write'], null)).toEqual([
      { path: 'retentionDays', issue: 'required_for_retain' },
    ]);
    expect(sourceUseIssues('cms_site', ['read', 'retain', 'write'], 90)).toEqual([]);
  });
});
