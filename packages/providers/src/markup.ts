/**
 * A linear-time scanner over HTML and XML markup. Untrusted pages and documents are read with it instead of
 * regular expressions with nested or lazy quantifiers (which go quadratic or worse on crafted input): every character
 * is visited a bounded number of times, whatever the input. It yields text runs and tags (name, closing or
 * self-closing, attributes); comments, doctypes and processing instructions are skipped, and the contents of raw-text
 * elements (script, style) are skipped to their closing tag. Nothing is executed and no DOM is built.
 */
export type MarkupToken =
  | { type: 'text'; text: string }
  | { type: 'open'; name: string; attrs: Map<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string };

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'template']);

const isNameChar = (c: number) =>
  (c >= 97 && c <= 122) ||
  (c >= 65 && c <= 90) ||
  (c >= 48 && c <= 57) ||
  c === 45 ||
  c === 58 ||
  c === 95 ||
  c === 46;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/** Attributes of a tag body (between the name and `>`), parsed in one pass. */
function parseAttrs(s: string, from: number, to: number): Map<string, string> {
  const out = new Map<string, string>();
  let i = from;
  while (i < to) {
    while (i < to && (isSpace(s.charCodeAt(i)) || s[i] === '/')) i++;
    const start = i;
    while (i < to && !isSpace(s.charCodeAt(i)) && s[i] !== '=' && s[i] !== '/' && s[i] !== '>') i++;
    if (i === start) {
      i++;
      continue;
    }
    const name = s.slice(start, i).toLowerCase();
    while (i < to && isSpace(s.charCodeAt(i))) i++;
    let value = '';
    if (s[i] === '=') {
      i++;
      while (i < to && isSpace(s.charCodeAt(i))) i++;
      const q = s[i];
      if (q === '"' || q === "'") {
        let stop = i + 1;
        while (stop < to && s[stop] !== q) stop++;
        value = s.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const vs = i;
        while (i < to && !isSpace(s.charCodeAt(i)) && s[i] !== '>') i++;
        value = s.slice(vs, i);
      }
    }
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * The end of a tag starting at `from` (the index of its `>`), honouring quoted attribute values; -1 if none. Any `<`,
 * even inside quotes, ends the attempt, so no `<` is ever scanned past twice and the whole scan stays linear.
 */
function tagEnd(s: string, from: number): number {
  let quote = 0;
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 60) return -1; // a stray `<`: treat the earlier `<` as text
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 62) return i;
  }
  return -1;
}

/**
 * Scans markup into tokens. `rawText` names elements whose contents are not markup (HTML: script, style...; XML:
 * none). Names are lower-cased for HTML; XML names keep their prefix (w:p) and are lower-cased too.
 */
export function* scanMarkup(s: string, opts: { rawText?: boolean } = {}): Generator<MarkupToken> {
  const raw = opts.rawText ?? true;
  let i = 0;
  let text = 0;
  const flush = function* (to: number): Generator<MarkupToken> {
    if (to > text) yield { type: 'text', text: s.slice(text, to) };
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    const next = s.charCodeAt(lt + 1);
    if (s.startsWith('<!--', lt)) {
      yield* flush(lt);
      const end = s.indexOf('-->', lt + 4);
      i = text = end < 0 ? s.length : end + 3;
      continue;
    }
    if (next === 33 || next === 63) {
      // <!doctype ...>, <![CDATA[...]]>, <?xml ...?>
      yield* flush(lt);
      if (s.startsWith('<![CDATA[', lt)) {
        const end = s.indexOf(']]>', lt + 9);
        const stop = end < 0 ? s.length : end;
        yield { type: 'text', text: s.slice(lt + 9, stop) };
        i = text = end < 0 ? s.length : end + 3;
      } else {
        const end = s.indexOf('>', lt + 2);
        i = text = end < 0 ? s.length : end + 1;
      }
      continue;
    }
    const closing = next === 47;
    let n = lt + (closing ? 2 : 1);
    const nameStart = n;
    while (n < s.length && isNameChar(s.charCodeAt(n))) n++;
    if (n === nameStart) {
      i = lt + 1; // `<` not starting a tag: it stays in the text run
      continue;
    }
    const end = tagEnd(s, n);
    if (end < 0) {
      i = lt + 1;
      continue;
    }
    yield* flush(lt);
    const name = s.slice(nameStart, n).toLowerCase();
    if (closing) {
      yield { type: 'close', name };
      i = text = end + 1;
      continue;
    }
    const selfClosing = s.charCodeAt(end - 1) === 47;
    yield { type: 'open', name, attrs: parseAttrs(s, n, selfClosing ? end - 1 : end), selfClosing };
    i = text = end + 1;
    if (raw && !selfClosing && RAW_TEXT.has(name)) {
      // Contents up to the matching close tag are not markup (found case-insensitively, in one pass).
      const close = indexOfCloseTag(s, name, i);
      const stop = close < 0 ? s.length : close;
      yield { type: 'text', text: s.slice(i, stop) };
      yield { type: 'close', name };
      const gt = close < 0 ? -1 : s.indexOf('>', close);
      i = text = gt < 0 ? s.length : gt + 1;
    }
  }
  yield* flush(s.length);
}

/** The index of `</name` (any case) at or after `from`, or -1; linear in the distance scanned. */
function indexOfCloseTag(s: string, name: string, from: number): number {
  for (let at = s.indexOf('</', from); at >= 0; at = s.indexOf('</', at + 2))
    if (s.slice(at + 2, at + 2 + name.length).toLowerCase() === name) {
      const after = s.charCodeAt(at + 2 + name.length);
      if (Number.isNaN(after) || !isNameChar(after)) return at;
    }
  return -1;
}
