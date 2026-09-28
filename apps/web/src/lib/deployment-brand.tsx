import { createContext, useContext } from 'react';

/**
 * D-12: the product keeps its own neutral brand in code; each deployment loads its own brand at deploy time. The web
 * image carries every brand pack (apps/web/deployment-brands/<key>/) and the web server serves the one named by
 * OREMEDIA_DEPLOYMENT_BRAND at /deployment-brand/, so one build is promoted between environments unchanged. A pack
 * names the deployment and may bring a stylesheet that overrides the semantic tokens and a logo per theme. It styles
 * the chrome only; customer brand tokens still style creative documents.
 */
export interface DeploymentBrand {
  name: string;
  /** Logo files inside the pack, for light and dark backgrounds; null shows the name alone. */
  logo: { light: string; dark: string } | null;
}

export const NEUTRAL_BRAND: DeploymentBrand = { name: 'Oremedia', logo: null };

const BASE = '/deployment-brand/';
/** A missing or slow pack never blocks the app for long: it starts in the neutral brand instead. */
const LOAD_TIMEOUT_MS = 1500;

const parse = (value: unknown): (DeploymentBrand & { stylesheet: boolean }) | null => {
  if (!value || typeof value !== 'object') return null;
  const v = value as { name?: unknown; stylesheet?: unknown; logo?: { light?: unknown; dark?: unknown } };
  if (typeof v.name !== 'string' || v.name.trim() === '' || v.name.length > 80) return null;
  const file = (f: unknown) => typeof f === 'string' && /^[a-z0-9-]+\.svg$/.test(f);
  const logo =
    v.logo && file(v.logo.light) && file(v.logo.dark)
      ? { light: `${BASE}${v.logo.light as string}`, dark: `${BASE}${v.logo.dark as string}` }
      : null;
  return { name: v.name.trim(), logo, stylesheet: v.stylesheet === true };
};

const stylesheetLoaded = (): Promise<void> =>
  new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${BASE}theme.css`;
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.append(link);
  });

/**
 * Loads the deployment's pack before the first render (so neither the name nor the colours flash): its brand.json,
 * then its stylesheet when it has one. Anything missing or malformed falls back to the neutral brand.
 */
export async function loadDeploymentBrand(): Promise<DeploymentBrand> {
  const load = async (): Promise<DeploymentBrand> => {
    try {
      const res = await fetch(`${BASE}brand.json`, { cache: 'no-cache' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return NEUTRAL_BRAND;
      const pack = parse(await res.json());
      if (!pack) return NEUTRAL_BRAND;
      if (pack.stylesheet) await stylesheetLoaded();
      return { name: pack.name, logo: pack.logo };
    } catch {
      return NEUTRAL_BRAND;
    }
  };
  const timeout = new Promise<DeploymentBrand>((resolve) =>
    setTimeout(() => resolve(NEUTRAL_BRAND), LOAD_TIMEOUT_MS),
  );
  return Promise.race([load(), timeout]);
}

const DeploymentBrandContext = createContext<DeploymentBrand>(NEUTRAL_BRAND);
export const DeploymentBrandProvider = DeploymentBrandContext.Provider;
export const useDeploymentBrand = (): DeploymentBrand => useContext(DeploymentBrandContext);
