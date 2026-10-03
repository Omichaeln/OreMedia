import { describe, expect, it } from 'vitest';
import { factDedupeKey, factSimilarity, normaliseFactStatement, possibleDuplicates } from './facts';

describe('fact duplicate detection (BSC-3)', () => {
  it('normalises case, punctuation, spacing and compatibility forms', () => {
    expect(normaliseFactStatement('  Founded in 1998.  ')).toBe('founded in 1998');
    expect(normaliseFactStatement('ＦＲＥＥ delivery—over £50!')).toBe('free delivery over £50');
    expect(factDedupeKey('Founded in 1998.')).toBe(factDedupeKey('founded   in 1998'));
    expect(factDedupeKey('Founded in 1998')).not.toBe(factDedupeKey('Founded in 1999'));
    expect(factDedupeKey('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps currency symbols, percent and minus signs: different amounts are different facts', () => {
    expect(factDedupeKey('$10/month')).not.toBe(factDedupeKey('€10/month'));
    expect(factDedupeKey('Save 10%')).not.toBe(factDedupeKey('Save 10'));
    expect(factDedupeKey('Temperature -5')).not.toBe(factDedupeKey('Temperature 5'));
    expect(factDedupeKey('From $10 a month.')).toBe(factDedupeKey('from $10 a month'));
  });

  it('scores word overlap and lists close statements both ways', () => {
    expect(factSimilarity('Free delivery on orders over 50', 'free delivery on orders over 50.')).toBe(1);
    expect(factSimilarity('Free delivery', 'Open on Sundays')).toBe(0);
    const dupes = possibleDuplicates([
      { id: 'f1', statement: 'We deliver free on all orders over 50 pounds' },
      { id: 'f2', statement: 'We deliver free on all orders over 50 pounds in the UK' },
      { id: 'f3', statement: 'Open on Sundays' },
      { id: 'f4', statement: 'open on sundays!' },
    ]);
    expect(dupes.get('f1')).toEqual(['f2']);
    expect(dupes.get('f2')).toEqual(['f1']);
    expect(dupes.get('f3')).toEqual(['f4']);
    expect(dupes.has('f5')).toBe(false);
  });
});
