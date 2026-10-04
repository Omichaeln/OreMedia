import { describe, expect, it } from 'vitest';
import { scanMarkup } from './markup';
import { LINEAR_RATIO_MAX, LINEAR_SAFETY_MS, timeGrowth } from './testing/linear-time';

/** Inputs that sent the earlier regular expressions quadratic (or worse) must take time linear in their size. */
const linear = (input: (size: number) => string, size = 10_000) => {
  const growth = timeGrowth(input, (markup) => [...scanMarkup(markup)].length, { size });
  expect(growth.ratio).toBeLessThan(LINEAR_RATIO_MAX);
  expect(growth.largeMs).toBeLessThan(LINEAR_SAFETY_MS);
};

describe('scanMarkup', () => {
  it('yields text, tags with attributes, and raw-text contents; skips comments and doctypes', () => {
    const tokens = [
      ...scanMarkup(
        '<!doctype html><!-- x --><P class="a > b" data-x=1 hidden>Hi<br/><script>if (a<b) "</p>"</SCRIPT>&amp;</p>',
      ),
    ];
    expect(tokens).toEqual([
      {
        type: 'open',
        name: 'p',
        attrs: new Map([
          ['class', 'a > b'],
          ['data-x', '1'],
          ['hidden', ''],
        ]),
        selfClosing: false,
      },
      { type: 'text', text: 'Hi' },
      { type: 'open', name: 'br', attrs: new Map(), selfClosing: true },
      { type: 'open', name: 'script', attrs: new Map(), selfClosing: false },
      { type: 'text', text: 'if (a<b) "</p>"' },
      { type: 'close', name: 'script' },
      { type: 'text', text: '&amp;' },
      { type: 'close', name: 'p' },
    ]);
  });

  it('a stray `<` stays text', () => {
    expect([...scanMarkup('a < b <c d')]).toEqual([{ type: 'text', text: 'a < b <c d' }]);
  });

  it.each([
    ['unclosed tags', (n: number) => '<a '.repeat(n)],
    ['bare angle brackets', (n: number) => '<'.repeat(n)],
    ['unclosed quotes', (n: number) => '<a "'.repeat(n)],
    ['unclosed comments', (n: number) => '<!--'.repeat(n)],
    ['unclosed raw text', (n: number) => '<script>'.repeat(n)],
    ['deep nesting', (n: number) => '<div aria-hidden=true>'.repeat(n / 10)],
  ])(
    'stays linear on %s',
    (_, input) => {
      linear(input);
    },
    30_000,
  );

  it('a quoted attribute value may hold `<` (as older serialisers write `alt="a < b"`); outside quotes it ends the tag', () => {
    expect([...scanMarkup('<img alt="a < b" src=x.png><a title=\'1<2\'>t</a>')]).toEqual([
      {
        type: 'open',
        name: 'img',
        attrs: new Map([
          ['alt', 'a < b'],
          ['src', 'x.png'],
        ]),
        selfClosing: false,
      },
      { type: 'open', name: 'a', attrs: new Map([['title', '1<2']]), selfClosing: false },
      { type: 'text', text: 't' },
      { type: 'close', name: 'a' },
    ]);
    expect([...scanMarkup('<a b <p>x')]).toEqual([
      { type: 'text', text: '<a b ' },
      { type: 'open', name: 'p', attrs: new Map(), selfClosing: false },
      { type: 'text', text: 'x' },
    ]);
  });

  it.each([
    ['alternating quotes', (n: number) => '<a "<a \'<a '.repeat(n / 11)],
    ['alternating quotes, closed', (n: number) => '<a "<a \'<a "<a \'>'.repeat(n / 17)],
    ['one unclosed quote before many tags', (n: number) => `<a "${'<a '.repeat(n / 3)}`],
  ])(
    'stays linear on %s inside quoted values',
    (_, input) => {
      linear(input);
    },
    30_000,
  );
});
