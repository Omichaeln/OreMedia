/**
 * D-27: the interface sets its text in Lato. The face is requested once at start-up from the one font host the
 * production CSP admits for stylesheets (infra/railway/web/Caddyfile) and never awaited: text shows in the fallback
 * face until it arrives (display=swap), so a slow or blocked font host cannot delay the first render. A deployment
 * pack that names the same stylesheet (its brand.json under apps/web/deployment-brands) shares this request.
 */
export const APP_FONT_STYLESHEET =
  'https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap';

export function addStylesheet(href: string): HTMLLinkElement {
  const existing = document.head.querySelector<HTMLLinkElement>(`link[rel="stylesheet"][href="${href}"]`);
  if (existing) return existing;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
  return link;
}

export const requestAppFont = (): void => {
  addStylesheet(APP_FONT_STYLESHEET);
};
