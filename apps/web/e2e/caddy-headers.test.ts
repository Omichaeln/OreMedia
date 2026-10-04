import { describe, expect, it } from 'vitest';
import { cspDirectives } from '../../../tooling/scripts/smoke/checks';
import {
  MATCHER_SCOPED_HEADERS,
  parseCaddySecurityHeaders,
  productionSecurityHeaders,
  substitute,
} from './caddy-headers';

const STORE = 'https://acct.r2.cloudflarestorage.com';

describe('production security headers, read from infra/railway/web/Caddyfile', () => {
  it('finds the three header blocks and the app CSP, with the object store origin substituted', () => {
    const h = productionSecurityHeaders({ OBJECT_STORE_PUBLIC_ORIGIN: STORE });
    const csp = cspDirectives(h.app['Content-Security-Policy'] as string);
    expect(csp['connect-src']).toEqual(["'self'", STORE]);
    expect(csp['font-src']).toEqual(["'self'", 'https://fonts.gstatic.com', STORE]);
    // STU-2a: inline video and audio players load signed store URLs.
    expect(csp['media-src']).toEqual(["'self'", 'blob:', STORE]);
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(h.app['X-Frame-Options']).toBe('DENY');
    expect(h.deploymentBrand['Content-Security-Policy']).toContain("default-src 'none'");
    expect(h.legal['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(h.legal['Referrer-Policy']).toBe('no-referrer');
  });

  it('OBJECT_STORE_PUBLIC_ORIGIN unset is empty, as Caddy substitutes it: uploads are same-origin only', () => {
    const csp = cspDirectives(productionSecurityHeaders({}).app['Content-Security-Policy'] as string);
    expect(csp['connect-src']).toEqual(["'self'"]);
    expect(csp['font-src']).toEqual(["'self'", 'https://fonts.gstatic.com']);
    expect(csp['media-src']).toEqual(["'self'", 'blob:']);
  });

  it('ignores matcher-scoped header lines (the immutable cache header on /assets/*)', () => {
    expect(productionSecurityHeaders({}).app['Cache-Control']).toBeUndefined();
  });
});

describe('parseCaddySecurityHeaders is strict', () => {
  const ALLOWED = `header @assets Cache-Control "public, max-age=31536000, immutable"
		@theme path /theme-init.js
		header @theme Cache-Control no-cache`;
  const site = (appHeader: string, extra = '', routeLines = ALLOWED) => `{
	admin off # a comment
}
:{$PORT:8080} {
	handle {
		header {
${appHeader}
		}
		${routeLines}
	}
	handle_path /deployment-brand/* {
		header {
			Content-Security-Policy "default-src 'none'"
		}
	}
	handle_path /legal/* {
		header {
			Content-Security-Policy "default-src 'none'"
		}
	}
${extra}
}`;

  it('reads quoted and bare values and substitutes placeholders with defaults', () => {
    const h = parseCaddySecurityHeaders(
      site(
        `X-Content-Type-Options nosniff\nContent-Security-Policy "connect-src 'self' {$A} {$B:https://b.test}"`,
      ),
      { A: 'https://a.test' },
    );
    expect(h.app).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "connect-src 'self' https://a.test https://b.test",
    });
  });

  it('refuses header operations, nested blocks, missing blocks and unbalanced braces', () => {
    expect(() => parseCaddySecurityHeaders(site(`-Server\nContent-Security-Policy "x"`))).toThrow(
      /Name value/,
    );
    expect(() => parseCaddySecurityHeaders(site(`Content-Security-Policy "x"\nX-Extra {\n}`))).toThrow(
      /Name value/,
    );
    expect(() => parseCaddySecurityHeaders(site(`X-Frame-Options DENY`))).toThrow(/Content-Security-Policy/);
    expect(() => parseCaddySecurityHeaders(site(`Content-Security-Policy "x"`, 'handle {\n}'))).toThrow(
      /one "handle" block/,
    );
    expect(() => parseCaddySecurityHeaders(`${site('Content-Security-Policy "x"')}\n}`)).toThrow(/unmatched/);
    expect(() => parseCaddySecurityHeaders(site('Content-Security-Policy "x'))).toThrow(/unterminated/);
  });

  it('refuses any header directive outside the bare block unless it is an allowlisted matcher-scoped line', () => {
    const csp = 'Content-Security-Policy "x"';
    expect(() => parseCaddySecurityHeaders(site(csp))).not.toThrow();
    for (const line of [
      'header @assets Cache-Control "x"', // allowlisted directive, different value
      'header @other X-Frame-Options SAMEORIGIN', // another matcher
      'header X-Frame-Options SAMEORIGIN', // single-line, unscoped: would change every response
      'header /assets/* Cache-Control no-store', // path matcher inline
    ])
      expect(() => parseCaddySecurityHeaders(site(csp, '', line))).toThrow(/unexpected header directive/);
    expect(MATCHER_SCOPED_HEADERS.map((t) => t[1])).toEqual(['@assets', '@theme']);
  });

  it('substitute: env value, default only when unset, runtime placeholders untouched', () => {
    expect(substitute('{$X}', {})).toBe('');
    expect(substitute('{$X:d}', {})).toBe('d');
    expect(substitute('{$X:d}', { X: 'v' })).toBe('v');
    expect(substitute('{$X:d}', { X: '' })).toBe('');
    expect(substitute('{path}.html', { path: 'no' })).toBe('{path}.html');
  });
});
