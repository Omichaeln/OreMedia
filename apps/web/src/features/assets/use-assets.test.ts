import { describe, expect, it } from 'vitest';
import { ALL_ASSET_CHIP, ASSET_LIST_CHIPS, cardState, type AssetListItemDto } from './use-assets';

const row = (over: Partial<AssetListItemDto>): AssetListItemDto =>
  ({
    id: 'ast_1',
    brandId: 'brd_1',
    kind: 'photo',
    name: 'Harvest bag',
    semanticRole: null,
    state: 'approved',
    rightsState: 'recorded',
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    currentVersion: null,
    rights: { owner: 'Studio', permittedChannels: 'all', territories: 'all', expiresAt: null },
    issues: [],
    ...over,
  }) as AssetListItemDto;

const chip = (key: string) => {
  const c = ASSET_LIST_CHIPS.find((x) => x.key === key);
  if (!c) throw new Error(`no chip ${key}`);
  return c;
};

/** The interface's chips over the librarian's list: server filters where assets.list has them, `keep` otherwise. */
describe('ASSET_LIST_CHIPS', () => {
  it('offers the interface’s chips in its order, without Duplicates (ingest refuses a duplicate file)', () => {
    expect(ASSET_LIST_CHIPS.map((c) => c.label)).toEqual([
      'All',
      'Needs attention',
      'Approved',
      'Expiring',
      'Missing rights',
      'Restricted',
      'Retired',
    ]);
    expect(ASSET_LIST_CHIPS[0]).toBe(ALL_ASSET_CHIP);
  });

  it('All, Needs attention, Approved and Retired are server filters with nothing kept back client-side', () => {
    expect(chip('all')).toMatchObject({ filter: {} });
    expect(chip('all').keep).toBeUndefined();
    expect(chip('attention')).toMatchObject({ filter: { needsAttention: true } });
    expect(chip('attention').keep).toBeUndefined();
    expect(chip('approved')).toMatchObject({ filter: { state: 'approved' } });
    expect(chip('retired')).toMatchObject({ filter: { state: 'retired' } });
  });

  it('Expiring keeps rows whose rights expire or have expired, over the attention rows', () => {
    const c = chip('expiring');
    expect(c.filter).toEqual({ needsAttention: true });
    expect(c.keep?.(row({ issues: ['rights_expiring'] }))).toBe(true);
    expect(c.keep?.(row({ issues: ['pending_review', 'rights_expired'] }))).toBe(true);
    expect(c.keep?.(row({ issues: ['rights_unknown'] }))).toBe(false);
    expect(c.keep?.(row({ issues: [] }))).toBe(false);
    expect(c.looksFor).toBeTruthy();
  });

  it('Missing rights keeps rows with no rights recorded', () => {
    const c = chip('missing');
    expect(c.filter).toEqual({ needsAttention: true });
    expect(c.keep?.(row({ rights: null, rightsState: 'unknown', issues: ['rights_unknown'] }))).toBe(true);
    expect(c.keep?.(row({ issues: ['rights_expiring'] }))).toBe(false);
  });

  it('Restricted keeps rows whose rights name particular channels or territories', () => {
    const c = chip('restricted');
    expect(c.filter).toEqual({});
    expect(
      c.keep?.(
        row({
          rights: { owner: 'Studio', permittedChannels: ['linkedin'], territories: 'all', expiresAt: null },
        }),
      ),
    ).toBe(true);
    expect(
      c.keep?.(
        row({ rights: { owner: 'Studio', permittedChannels: 'all', territories: ['GH'], expiresAt: null } }),
      ),
    ).toBe(true);
    expect(c.keep?.(row({}))).toBe(false);
    expect(c.keep?.(row({ rights: null, rightsState: 'unknown', issues: ['rights_unknown'] }))).toBe(false);
  });
});

describe('cardState', () => {
  it('no issue is Cleared in the good tone', () => {
    expect(cardState([])).toEqual({ tone: 'good', label: 'Cleared' });
  });

  it('the first issue carries the dot and every issue is named', () => {
    expect(cardState(['pending_review', 'rights_unknown'])).toEqual({
      tone: 'info',
      label: 'Pending review · Missing rights',
    });
    expect(cardState(['rights_expired'])).toEqual({ tone: 'critical', label: 'Expired rights' });
    expect(cardState(['retired'])).toEqual({ tone: 'neutral', label: 'Retired' });
  });
});
