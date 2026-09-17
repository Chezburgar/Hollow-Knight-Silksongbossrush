/*
 * Where the game's own files (Build/, StreamingAssets/) are served from.
 *
 * The page used to do this with a <base> tag, which also redirected this
 * project's own files to the CDN and raced the browser's preload scanner.
 * Resolving an explicit root instead keeps the two apart: game assets from the
 * CDN, launcher files from wherever index.html lives.
 */

/*
 * This fork carries its own copy of Build/ and StreamingAssets/, including the
 * loader fixes and the archive index, so it must serve them from here rather
 * than from the upstream port.
 */
export const CDN_ROOT =
  "https://cdn.jsdelivr.net/gh/chezburgar/hollow-knight-silksongbossrush@master/";

function resolveAssetRoot() {
  const override = new URLSearchParams(location.search).get("assets");
  if (override) return new URL(override, location.href).href.replace(/\/?$/, "/");

  // Serving the repo directly (the README's `python -m http.server` flow):
  // use the files next to index.html rather than the CDN copy.
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname) ||
      location.protocol === "file:") {
    return location.href.replace(/[^/]*(\?.*)?$/, "");
  }

  return CDN_ROOT;
}

export const ASSET_ROOT = resolveAssetRoot();
export const asset = (path) => ASSET_ROOT + path;
