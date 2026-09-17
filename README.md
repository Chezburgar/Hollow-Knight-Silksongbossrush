# Hollow Knight: Silksong — Boss Rush

A web port of [Hollow Knight: Silksong](https://hollowknightsilksong.com/), with a
boss rush layer bolted on and an asset pipeline that no longer makes you download
two gigabytes before you can see the title screen.

---

## Boss Rush

Press <kbd>`</kbd> (or the **Boss Rush** button, top right) to open the launcher.

| Tab | What's in it |
| --- | --- |
| **Bosses** | 36 fight rooms, grouped by zone. Click one to go straight there. |
| **Gauntlets** | Ready-made chains — every named boss, every arena, the memory fights, the bell shrines — plus a picker for building your own in whatever order you like. |
| **All rooms** | All 371 rooms in the build, searchable. |
| **Setup** | Render scale, download stats, save tools. |

During a gauntlet a bar at the top shows which fight you're on and how long the run
has taken. Press <kbd>]</kbd> when a fight is done to move to the next one.

### How it works, and what it needs from you

A compiled Unity build won't load an arbitrary scene from outside and still give you
a working hero, HUD and camera — only the game's own "continue a save" path sets all
that up. So a warp is a save edit: Boss Rush points your save's `respawnScene` at the
arena you picked and reloads the page. Continue your game and you wake up there.

That means **you need a save to exist first**. Start a game in Silksong once so it
writes one, then pick your fight. Boss Rush edits the file the game wrote rather than
inventing one, so it can't corrupt a slot it didn't create, and the first warp stashes
your untouched save next to the slot — **Setup → Restore pre-warp save** always puts it
back.

**Setup → Check save format** decodes your slot and re-encodes it, then compares the
bytes. A pass means a warp writes a file byte-for-byte like the game's own apart from
the respawn fields it means to change. Worth clicking once before your first run.

If an arena drops you somewhere odd, warp to the room next door from **All rooms**, or
change the respawn marker name under **Setup → Advanced**.

---

## Performance and downloads

The 21 largest asset bundles don't fit a CDN's per-file limit, so they live inside
`StreamingAssets/aa/WebGL.zip`, split across 100 numbered parts. The page used to
download all 100 of them — 1.94 GiB — before the game could start, hold the whole
archive in memory twice while JSZip unpacked every entry into the Cache API, and leave
that copy sitting on disk next to the one Unity keeps in IndexedDB.

Now a 2.7 KB index (`StreamingAssets/aa/webgl-zip-index.json`) records where each entry
lives inside the virtual concatenation of the parts. When Unity asks for one of those
bundles, only the byte range holding it is fetched, inflated through the browser's
native `DecompressionStream`, and streamed straight back; Unity's own cache layer keeps
it. Nothing is downloaded until the game asks for it.

Measured locally, booting to the title screen:

| | Before | After |
| --- | --- | --- |
| Downloaded before anything renders | ~1.94 GiB | ~35 MB (engine only) |
| Time to a running Unity instance | after the whole archive | 2.7 s |
| Peak memory during load | whole archive, buffered twice | one 20 MB part at a time |
| Copies kept on disk | Cache API **and** IndexedDB | IndexedDB only |

Silksong's own Addressables setup then preloads most asset groups in the background
while you sit at the menu — about 1.4 GiB of the archive, which is engine behaviour a
web page can't opt out of. The difference is that it's background streaming rather than
a wall: the game is up and interactive in seconds, and the ~570 MB of scene and
cinematic bundles are only fetched if you actually go somewhere that needs them.

Other things that got faster:

- `jszip.js` (374 KB, parsed on every visit) is gone.
- The old fetch hook did a Cache API lookup on *every* request the game made. The new
  one only touches URLs naming one of the 21 archived bundles.
- Bundles are marked `immutable`, so repeat visits serve them from IndexedDB with no
  revalidation round-trip each. Their filenames carry a content hash, so this is safe.
- **Setup → Render scale** lowers the resolution Unity renders at while the canvas still
  fills the window. It's the strongest framerate lever a WebGL build has: 50% renders a
  quarter of the pixels.
- Returning players get the old ~2 GB Cache API copy deleted automatically on first load.

### Fixes to the Unity loader

`Build/w-pt.loader.js` carries two one-line corrections:

- Its gzip `hasUnityMarker` was hardcoded to `return true`, so the loader inflated the
  player files in JavaScript unconditionally — and broke outright if a server sent a
  correct `Content-Encoding: gzip`. It now checks for the actual gzip magic bytes, which
  keeps today's behaviour and lets a properly configured server hand decompression to
  the browser.
- `streamingAssetsUrl` was overwritten from `document.querySelector('base').href`,
  ignoring the configured value and throwing if no `<base>` element existed. It now uses
  the configured URL, falling back to `<base>` and then the document base.

---

## Running it yourself

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. Served from `localhost`, the page uses the files in
this repository. Anywhere else it pulls game assets from this repo on jsDelivr; point it
somewhere else with `?assets=https://example.com/silksong/`.

A server that honours HTTP range requests (nginx, Caddy, `npx http-server`) lets Boss
Rush fetch exact byte ranges out of the archive. Python's `http.server` doesn't, so it
falls back to whole 20 MB parts — slower, but correct either way.

## Layout

```
bossrush/
  assets.js    on-demand extraction of bundles from the split archive
  boot.js      Unity startup, cache policy, render scale
  config.js    where game assets are served from
  save.js      Silksong's save container: AES-256-ECB + .NET BinaryFormatter, in IDBFS
  warp.js      patching a save's respawn point, backups, gauntlet state
  arenas.js    generated from the game's own Addressables catalog
  launcher.js  the UI
```
