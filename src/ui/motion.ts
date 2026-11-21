// Motion: how much the app animates, and the view-transition helpers.
//
//   full  — startup splash with a live shader, thumbnail → stage morphs (View Transitions), staggered
//           grid, state pops. Default on Windows and macOS.
//   calm  — short splash, plain fades, no per-cell animation. Default on Linux (WebKitGTK repaints
//           are expensive there) and whenever the OS asks for reduced motion.
//   off   — nothing moves that doesn't have to.
//
// settings.motion = 'auto' | 'full' | 'calm' | 'off' (default auto). The resolved level is on
// <html data-motion="…"> so CSS (and mods' CSS) can key off it.

export type Motion = 'full' | 'calm' | 'off';

export function resolveMotion(setting: unknown, platform: string, prefersReduced: boolean): Motion {
  if (setting === 'full' || setting === 'calm' || setting === 'off') return setting;
  if (prefersReduced) return 'calm';
  return platform === 'linux' ? 'calm' : 'full';
}

export function applyMotion(m: Motion) {
  document.documentElement.dataset.motion = m;
}

export function currentMotion(): Motion {
  return (document.documentElement.dataset.motion as Motion) ?? 'full';
}

const HERO = 'glslop-hero';

/**
 * Swap views inside a View Transition when the webview has them and motion is full; otherwise just
 * swap. `swap` replaces the DOM; `ready` resolves once the new view has drawn something worth
 * snapshotting (or gives up quickly: the page is frozen while we wait).
 *
 * heroKey: an element with data-hero="<key>" in the old view morphs into the one in the new view
 * (browse thumbnail ↔ shader stage).
 */
export function transitionViews(opts: {
  root: HTMLElement;
  swap: () => void;
  heroKey?: string | null;
}): void {
  const doc = document as any;
  if (currentMotion() !== 'full' || typeof doc.startViewTransition !== 'function') {
    opts.swap();
    return;
  }
  const key = opts.heroKey ? CSS.escape(opts.heroKey) : null;
  const oldHero = key ? opts.root.querySelector<HTMLElement>(`[data-hero="${key}"]`) : null;
  if (oldHero) oldHero.style.viewTransitionName = HERO;

  const vt = doc.startViewTransition(async () => {
    if (oldHero) oldHero.style.viewTransitionName = '';
    opts.swap();
    if (!key || !oldHero) return;
    // The new view may render its hero a little later (async data). Wait briefly, never long.
    const t0 = performance.now();
    let el: HTMLElement | null = null;
    // Timers, not requestAnimationFrame: rendering is paused while this callback runs, and rAF may
    // never fire until it returns.
    while (!(el = opts.root.querySelector<HTMLElement>(`[data-hero="${key}"]`)) && performance.now() - t0 < 220) {
      await new Promise((r) => setTimeout(r, 16));
    }
    if (el) el.style.viewTransitionName = HERO;
  });
  // A skipped or timed-out transition (a slow GPU stalling the update) still swaps the view; it just
  // doesn't animate. Swallow those rejections so they never surface as "unhandled error" toasts.
  vt.ready?.catch(() => {});
  vt.updateCallbackDone?.catch((e: unknown) => console.warn('view transition skipped:', e));
  vt.finished.catch(() => {}).finally(() => {
    opts.root.querySelectorAll<HTMLElement>('[data-hero]').forEach((e) => { if (e.style.viewTransitionName === HERO) e.style.viewTransitionName = ''; });
  });
}
