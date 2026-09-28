import { readFileSync } from 'node:fs';

/**
 * The security headers the production web container sets (infra/railway/web/Caddyfile), read from the Caddyfile
 * itself so the e2e static server serves exactly what Caddy serves and the two cannot drift. Deliberately small and
 * strict: it understands the block structure, quoted values, comments and `{$VAR}` / `{$VAR:default}` placeholders,
 * and throws on anything it does not expect inside the header blocks it reads (a `+`/`-` header operation, a nested
 * block, a line that is not `Name value`), so a Caddyfile change the e2e cannot mirror fails loudly instead of being
 * silently dropped.
 */
export interface CaddySecurityHeaders {
  /** The app's catch-all `handle { header { ... } }` (every SPA file and index.html). */
  app: Record<string, string>;
  /** `handle_path /deployment-brand/* { header { ... } }`. */
  deploymentBrand: Record<string, string>;
  /** `handle_path /legal/* { header { ... } }`. */
  legal: Record<string, string>;
}

type Env = Record<string, string | undefined>;

interface Node {
  tokens: string[];
  line: number;
  children: Node[] | null;
}

export const CADDYFILE_PATH = new URL('../../../infra/railway/web/Caddyfile', import.meta.url);

/** Reads the repository's Caddyfile and resolves its header blocks against `env` (the web container's variables). */
export function productionSecurityHeaders(env: Env = {}): CaddySecurityHeaders {
  return parseCaddySecurityHeaders(readFileSync(CADDYFILE_PATH, 'utf8'), env);
}

export function parseCaddySecurityHeaders(caddyfile: string, env: Env = {}): CaddySecurityHeaders {
  const top = parseBlocks(caddyfile);
  const sites = top.filter((n) => n.children && n.tokens.length > 0);
  if (sites.length !== 1) throw new Error(`Caddyfile: expected one site block, found ${sites.length}`);
  const site = (sites[0] as Node).children as Node[];
  const headersOf = (tokens: string[]): Record<string, string> => {
    const route = site.filter((n) => n.children && sameTokens(n.tokens, tokens));
    if (route.length !== 1) throw new Error(`Caddyfile: expected one "${tokens.join(' ')}" block`);
    const headerNodes = ((route[0] as Node).children as Node[]).filter((n) => n.tokens[0] === 'header');
    // Only the route's bare `header { ... }` block is mirrored; any other header directive must be one this parser
    // knows it may skip (MATCHER_SCOPED_HEADERS), so a new one fails here instead of being silently dropped.
    for (const n of headerNodes)
      if (
        !(n.children && sameTokens(n.tokens, ['header'])) &&
        !MATCHER_SCOPED_HEADERS.some((a) => sameTokens(n.tokens, a))
      )
        throw new Error(`Caddyfile line ${n.line}: unexpected header directive "${n.tokens.join(' ')}"`);
    const blocks = headerNodes.filter((n) => n.children && sameTokens(n.tokens, ['header']));
    if (blocks.length !== 1) throw new Error(`Caddyfile: expected one header block in "${tokens.join(' ')}"`);
    const out: Record<string, string> = {};
    for (const line of (blocks[0] as Node).children as Node[]) {
      const [name, value, ...rest] = line.tokens;
      if (
        line.children ||
        !name ||
        value === undefined ||
        rest.length ||
        !/^[A-Za-z][A-Za-z0-9-]*$/.test(name)
      )
        throw new Error(`Caddyfile line ${line.line}: expected "Name value" in a header block`);
      out[name] = substitute(value, env);
    }
    return out;
  };
  const headers = {
    app: headersOf(['handle']),
    deploymentBrand: headersOf(['handle_path', '/deployment-brand/*']),
    legal: headersOf(['handle_path', '/legal/*']),
  };
  for (const [route, h] of Object.entries(headers))
    if (!h['Content-Security-Policy']) throw new Error(`Caddyfile: no Content-Security-Policy for ${route}`);
  return headers;
}

/**
 * Header lines scoped to a path matcher that the e2e server deliberately does not mirror (caching only; it serves
 * everything with no-store). Anything else outside the bare header blocks makes the parser throw.
 */
export const MATCHER_SCOPED_HEADERS: readonly string[][] = [
  ['header', '@assets', 'Cache-Control', 'public, max-age=31536000, immutable'],
  ['header', '@theme', 'Cache-Control', 'no-cache'],
];

const sameTokens = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * Caddy's environment placeholders: `{$NAME}` is the variable's value, empty when unset; `{$NAME:default}` falls back
 * to the default when the variable is unset. Runtime placeholders such as `{path}` are left alone.
 */
export function substitute(value: string, env: Env): string {
  return value.replace(
    /\{\$([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g,
    (_m, name: string, fallback?: string) => {
      const v = env[name];
      return v !== undefined ? v : (fallback ?? '');
    },
  );
}

/** Lines of tokens; a line ending in `{` opens a block, a line that is only `}` closes it. */
function parseBlocks(source: string): Node[] {
  const root: Node = { tokens: [], line: 0, children: [] };
  const stack: Node[] = [root];
  source.split('\n').forEach((text, i) => {
    const tokens = tokenize(text, i + 1);
    if (!tokens.length) return;
    const parent = stack[stack.length - 1] as Node;
    if (tokens.length === 1 && tokens[0] === '}') {
      if (stack.length === 1) throw new Error(`Caddyfile line ${i + 1}: unmatched "}"`);
      stack.pop();
      return;
    }
    const opens = tokens[tokens.length - 1] === '{';
    const own = opens ? tokens.slice(0, -1) : tokens;
    if (own.some((t) => t === '{' || t === '}'))
      throw new Error(`Caddyfile line ${i + 1}: braces must open at the end of a line and close alone`);
    const node: Node = { tokens: own, line: i + 1, children: opens ? [] : null };
    (parent.children as Node[]).push(node);
    if (opens) stack.push(node);
  });
  if (stack.length !== 1) throw new Error('Caddyfile: unclosed block');
  return root.children as Node[];
}

/** Whitespace-separated tokens; a double-quoted token may hold spaces (and \" escapes); `#` starts a comment. */
function tokenize(text: string, line: number): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') break;
    if (c === '"') {
      let value = '';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) i++;
        value += text[i];
        i++;
      }
      if (text[i] !== '"') throw new Error(`Caddyfile line ${line}: unterminated quoted value`);
      i++;
      tokens.push(value);
      continue;
    }
    let word = '';
    while (i < text.length && !/\s/.test(text[i] as string)) word += text[i++];
    tokens.push(word);
  }
  return tokens;
}
