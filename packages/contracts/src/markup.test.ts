import { describe, expect, it } from 'vitest';
import { scanMarkup } from './markup';

/** Inputs that sent the earlier regular expressions quadratic (or worse) must finish in linear time. */
const fast = (run: () => unknown) => {
  const started = performance.now();
  run();
  expect(performance.now() - started).toBeLessThan(200);
};
const N = 50_000;

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
    ['unclosed tags', '<a '.repeat(N)],
    ['bare angle brackets', '<'.repeat(N)],
    ['unclosed quotes', '<a "'.repeat(N)],
    ['unclosed comments', '<!--'.repeat(N)],
    ['unclosed raw text', '<script>'.repeat(N)],
    ['deep nesting', '<div aria-hidden=true>'.repeat(N / 10)],
  ])('stays linear on %s', (_, input) => {
    fast(() => [...scanMarkup(input)].length);
  });

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
    ['alternating quotes', '<a "<a \'<a '.repeat(N / 11)],
    ['alternating quotes, closed', '<a "<a \'<a "<a \'>'.repeat(N / 17)],
    ['one unclosed quote before many tags', `<a "${'<a '.repeat(N / 3)}`],
  ])('stays linear on %s inside quoted values', (_, input) => {
    fast(() => [...scanMarkup(input)].length);
  });
});
