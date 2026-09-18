/*
 * assets.js - on-demand asset delivery for the Silksong web port.
 *
 * The 21 largest asset bundles are too big for a CDN to serve individually, so
 * they live inside StreamingAssets/aa/WebGL.zip, split into 100 numbered parts.
 * The old loader downloaded all 100 parts (1.94 GiB) before the game could
 * start, held the whole archive in memory twice, and unpacked every entry with
 * JSZip into the Cache API - on top of the copy Unity keeps in IndexedDB.
 *
 * Instead we ship a 2.7 KB index of where each entry lives inside the virtual
 * concatenation of the parts. When Unity asks for one of those bundles we fetch
 * only the byte range that holds it, inflate it with the browser's native
 * DecompressionStream, and hand the bytes straight back. Unity's own cache
 * layer stores the result, so each bundle is pulled at most once, ever.
 *
 * Nothing is downloaded until the game actually asks for it.
 */

import { candidateRoots } from "./config.js";

const INDEX_PATH = "StreamingAssets/aa/webgl-zip-index.json";

/** Set once a root is confirmed to actually serve the archive. */
let assetRoot = null;

/** Absolute URL for one of the game's files, valid after installAssetInterceptor. */
export function assetUrl(path) {
  if (!assetRoot) throw new Error("asset root not resolved yet");
  return assetRoot + path;
}

export function currentAssetRoot() {
  return assetRoot;
}

let zipIndex = null;

/** Bytes pulled over the network this session, by bundle name. */
export const stats = {
  bundles: new Map(),
  get networkBytes() {
    let n = 0;
    for (const b of this.bundles.values()) n += b.compressed;
    return n;
  },
};

/**
 * A root counts as usable only if it serves the index *and* the archive parts.
 * A Pages deploy that got truncated, or a host carrying just the launcher, will
 * hand back the small file and 404 the big ones - checking both is what tells
 * those apart before Unity starts asking for bundles.
 */
async function probeRoot(root) {
  const res = await fetch(root + INDEX_PATH, { cache: "no-cache" });
  if (!res.ok) throw new Error(`index ${res.status}`);
  const index = await res.json();
  const part = await fetch(root + index.base + "1", { method: "HEAD" });
  if (!part.ok) throw new Error(`archive ${part.status}`);
  return index;
}

async function resolveRoot(onNote) {
  const roots = candidateRoots();
  const failures = [];
  for (const root of roots) {
    try {
      onNote?.(root);
      zipIndex = await probeRoot(root);
      assetRoot = root;
      return zipIndex;
    } catch (err) {
      failures.push(`${root} (${err.message})`);
    }
  }
  throw new Error(
    "Could not find the game's asset files. Tried:\n  " +
      failures.join("\n  ") +
      "\n\nHost this page from a copy of the repository that includes " +
      "Build/ and StreamingAssets/, or point it at one with ?assets=<url>.",
  );
}

/**
 * Byte range [start, end) of the virtual archive, as a list of per-part reads.
 * Part N covers [(N-1)*partSize, N*partSize).
 */
function planReads(start, length) {
  const { part_size: partSize, base } = zipIndex;
  const reads = [];
  let offset = start;
  let remaining = length;
  while (remaining > 0) {
    const part = Math.floor(offset / partSize);
    const within = offset % partSize;
    const take = Math.min(remaining, partSize - within);
    reads.push({
      url: assetRoot + `${base}${part + 1}`,
      from: within,
      to: within + take - 1,
      length: take,
    });
    offset += take;
    remaining -= take;
  }
  return reads;
}

/**
 * A ReadableStream over one byte range. Ranged requests keep this to exactly
 * the bytes we need; if the host ignores Range and replies 200 we slice the
 * full part client-side, which costs bandwidth but stays correct.
 */
function rangeStream(read, netFetch) {
  return new ReadableStream({
    async start(controller) {
      try {
        const res = await netFetch(read.url, {
          headers: { Range: `bytes=${read.from}-${read.to}` },
        });
        if (!res.ok) throw new Error(`${read.url} -> ${res.status}`);

        if (res.status === 206) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } else {
          // No range support: take the whole part and cut out our slice.
          const whole = new Uint8Array(await res.arrayBuffer());
          controller.enqueue(whole.subarray(read.from, read.to + 1));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/** Concatenate several ranges into one continuous stream, fetched in order. */
function concatStream(reads, netFetch, onBytes) {
  let index = 0;
  let reader = null;
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (index >= reads.length) {
            controller.close();
            return;
          }
          reader = rangeStream(reads[index++], netFetch).getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        onBytes?.(value.length);
        controller.enqueue(value);
        return;
      }
    },
    cancel(reason) {
      reader?.cancel(reason);
    },
  });
}

/**
 * Serve one zipped bundle as a normal-looking Response. The body is a stream,
 * so peak memory is one part plus whatever the consumer retains - not the
 * 1.94 GiB the previous loader buffered.
 */
async function serveBundle(name, entry, netFetch, onProgress) {
  const reads = planReads(entry.o, entry.c);
  let fetched = 0;
  const compressed = concatStream(reads, netFetch, (n) => {
    fetched += n;
    onProgress?.(name, fetched, entry.c);
  });

  // method 8 is raw deflate; every entry in this archive uses it.
  const body =
    entry.m === 8
      ? compressed.pipeThrough(new DecompressionStream("deflate-raw"))
      : compressed;

  stats.bundles.set(name, { compressed: entry.c, uncompressed: entry.u });

  return new Response(body, {
    status: 200,
    statusText: "OK",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(entry.u),
    },
  });
}

/**
 * Install the interceptor. Only URLs naming one of the 21 archived bundles are
 * touched; everything else keeps the browser's own fetch with no added work,
 * which matters because Unity routes every asset request through window.fetch.
 */
export async function installAssetInterceptor(onProgress, onNote) {
  const netFetch = window.fetch.bind(window);
  await resolveRoot(onNote);
  const files = zipIndex.files;

  window.fetch = function (resource, options) {
    const url = typeof resource === "string" ? resource : resource?.url;
    if (typeof url === "string" && url.endsWith(".bundle")) {
      const name = url.slice(url.lastIndexOf("/") + 1);
      const entry = files[name];
      if (entry) return serveBundle(name, entry, netFetch, onProgress);
    }
    return netFetch(resource, options);
  };

  return zipIndex;
}

/** Ask the browser not to evict the game's cached bundles under pressure. */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* storage API unavailable - caching still works, just evictable */
  }
}

export async function storageEstimate() {
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
