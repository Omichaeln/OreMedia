/* global document, localStorage, matchMedia */
// Applied before paint so the chrome never flashes the wrong theme; the preference is a per-device convenience. A file,
// not an inline script: the production CSP (infra/railway/web/Caddyfile) allows scripts from 'self' only.
try {
  var t = localStorage.getItem('oremedia.theme');
  if (t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches))
    document.documentElement.setAttribute('data-theme', 'dark');
} catch {
  // storage blocked: the app applies the system preference once it starts
}
