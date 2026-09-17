/*
 * boot.js - starts the Unity player.
 *
 * Differences from the original inline loader:
 *  - nothing is downloaded up front except the player itself (~35 MB); asset
 *    bundles arrive on demand through assets.js
 *  - jszip is gone; inflation uses the browser's DecompressionStream
 *  - bundles are marked immutable, so Unity serves repeat visits straight from
 *    IndexedDB with no revalidation round-trip per bundle
 *  - loader, framework, wasm and data all come from one pinned ref instead of
 *    the loader tracking @latest while everything else tracked @master
 */

import { installAssetInterceptor, requestPersistentStorage, stats } from "./assets.js";
import { asset } from "./config.js";

const LEGACY_CACHES = /^hksilksongcache/;

const el = {
  status: document.querySelector("#boot-status"),
  detail: document.querySelector("#boot-detail"),
  bar: document.querySelector("#boot-bar-fill"),
  screen: document.querySelector("#boot-screen"),
  canvas: document.querySelector("#unity-canvas"),
};

function status(text, detail) {
  if (el.status) el.status.textContent = text;
  if (detail !== undefined && el.detail) el.detail.textContent = detail;
}

function progress(fraction) {
  if (el.bar) el.bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}

const mib = (n) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * The previous build unpacked the entire 1.94 GiB archive into the Cache API,
 * on top of the copy Unity keeps in IndexedDB. Returning players are still
 * carrying that; hand the disk space back.
 */
async function dropLegacyCaches() {
  try {
    const names = await caches.keys();
    const stale = names.filter((n) => LEGACY_CACHES.test(n));
    if (!stale.length) return 0;
    status("Reclaiming disk space", "removing the old 2 GB asset cache");
    await Promise.all(stale.map((n) => caches.delete(n)));
    return stale.length;
  } catch {
    return 0;
  }
}

/*
 * Render scale - the biggest framerate lever a WebGL build has.
 *
 * Unity sizes its drawing buffer as (canvas client size x preferred device
 * pixel ratio), and _JS_SystemInfo_GetPreferredDevicePixelRatio honours
 * Module.devicePixelRatio ahead of the window's. Lowering it renders fewer
 * pixels while the canvas still fills the screen. A resize event makes Unity
 * pick the new value up without a restart.
 */
export const RENDER_SCALE_KEY = "bossrush.renderScale";

export function storedRenderScale() {
  const v = Number(localStorage.getItem(RENDER_SCALE_KEY));
  return Number.isFinite(v) && v >= 0.25 && v <= 2 ? v : 1;
}

export function applyRenderScale(scale, instance = window.unityInstance) {
  localStorage.setItem(RENDER_SCALE_KEY, String(scale));
  if (instance?.Module) {
    instance.Module.devicePixelRatio = scale;
    window.dispatchEvent(new Event("resize"));
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.body.appendChild(s);
  });
}

export async function boot() {
  await dropLegacyCaches();
  await requestPersistentStorage();

  status("Preparing assets", "reading the asset index (3 KB)");
  await installAssetInterceptor((name, done, total) => {
    const short = name.replace(/^packed-/, "").replace(/_assets_all.*$/, "");
    status("Streaming assets", `${short} - ${mib(done)} / ${mib(total)}`);
  });

  const buildUrl = asset("Build");
  const config = {
    dataUrl: `${buildUrl}/w-pt.data.unityweb`,
    frameworkUrl: `${buildUrl}/w-pt.framework.js.unityweb`,
    codeUrl: `${buildUrl}/w-pt.wasm.unityweb`,
    streamingAssetsUrl: asset("StreamingAssets"),
    companyName: "EDUrocks Group, Truffled, GN-Math",
    productName: "Hollow Knight SilkSong",
    productVersion: "1.0",
    // Bundle filenames carry a content hash, so they can never change under a
    // given name. "immutable" lets Unity skip a revalidation request per
    // bundle on every single load.
    cacheControl: (url) =>
      /\.bundle$/.test(url) || url === `${buildUrl}/w-pt.data.unityweb`
        ? "immutable"
        : "no-store",
    autoSyncPersistentDataPath: true,
    // Copied onto Module by the loader, so the first frame already renders at
    // the chosen scale instead of flashing at full resolution first.
    devicePixelRatio: storedRenderScale(),
    showBanner: (msg, type) => {
      if (type === "error") console.error(msg);
      else console.warn(msg);
    },
  };

  status("Loading engine", "player code (~35 MB, cached after first visit)");
  await loadScript(`${buildUrl}/w-pt.loader.js`);

  const instance = await createUnityInstance(el.canvas, config, (p) => {
    progress(p);
    if (p < 1) status("Loading engine", `${Math.round(p * 100)}%`);
  });

  progress(1);
  status("Ready", "");
  el.screen?.classList.add("hidden");

  window.unityInstance = instance;
  return instance;
}

export { stats };
