import { useCallback, useEffect, useState } from 'react';

export interface StudioPanels {
  /** Layers, assets and templates. */
  left: boolean;
  /** Properties and the document panels (agent, comments, history, render). */
  right: boolean;
}
const KEY = 'oremedia.studio.panels';
/** Below this width both side panels leave the canvas under its minimum, so the right one starts hidden. */
const WIDE = '(min-width: 1024px)';

const read = (): StudioPanels => {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<StudioPanels>;
      if (typeof parsed.left === 'boolean' && typeof parsed.right === 'boolean')
        return { left: parsed.left, right: parsed.right };
    }
  } catch {
    // storage blocked or unreadable: fall through to the width-based default
  }
  return { left: true, right: matchMedia(WIDE).matches };
};

/**
 * UX-18: which side panels the studio shows, a per-device convenience kept like the theme. The canvas column never
 * drops below its minimum (the grid template in studio.tsx), so on a tablet the person chooses which panel to see.
 */
export function useStudioPanels(): { panels: StudioPanels; toggle: (side: keyof StudioPanels) => void } {
  const [panels, setPanels] = useState<StudioPanels>(read);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(panels));
    } catch {
      // storage blocked: the choice still applies for this page
    }
  }, [panels]);
  const toggle = useCallback(
    (side: keyof StudioPanels) => setPanels((p) => ({ ...p, [side]: !p[side] })),
    [],
  );
  return { panels, toggle };
}
