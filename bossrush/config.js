/*
 * Where the game's own files (Build/, StreamingAssets/) are served from.
 *
 * The page used to fix this with a <base> tag, which also redirected this
 * project's own files to the CDN and raced the browser's preload scanner.
 * Instead we keep the two apart - launcher files always come from wherever
 * index.html lives - and let boot decide at runtime where the game files are,
 * because that differs per host:
 *
 *   - a clone served locally, or a GitHub Pages deploy of this repository,
 *     has the whole 2.3 GB sitting next to index.html
 *   - a page hosted on its own needs a CDN copy
 *
 * Probing beats guessing: a wrong guess is a 404 at boot with nothing to act
 * on, which is exactly how the first Pages deploy failed.
 */

/*
 * Pinned to the commit that introduced the archive index and the loader fixes,
 * so the fallback works regardless of which branch is checked out where. A
 * commit ref is also immutable, which is the best thing you can hand a CDN.
 */
export const CDN_ROOT =
  "https://cdn.jsdelivr.net/gh/chezburgar/hollow-knight-silksongbossrush" +
  "@6e2e9e575f3c904ac517a889030eaeb1b72f67a1/";

/** The directory index.html was served from. */
export const PAGE_ROOT = new URL(".", location.href).href;

/**
 * Roots to try, in order. The first one that actually serves the archive wins.
 */
export function candidateRoots() {
  const override = new URLSearchParams(location.search).get("assets");
  if (override) {
    return [new URL(override, location.href).href.replace(/\/?$/, "/")];
  }
  // Same origin first: those files are the ones this exact build was deployed
  // with, so the launcher and the game can never drift apart.
  return [PAGE_ROOT, CDN_ROOT];
}
