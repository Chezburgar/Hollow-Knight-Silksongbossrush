/*
 * launcher.js - the Boss Rush front end.
 *
 * Sits over the Unity canvas: pick a fight, chain fights into a gauntlet, and
 * tune how hard the page works. Everything it does to the game goes through
 * warp.js, which edits the save slot the game itself wrote.
 */

import { ARENAS, ROOMS, GAUNTLETS } from "./arenas.js";
import * as warp from "./warp.js";
import { applyRenderScale, storedRenderScale, stats } from "./boot.js";
import { currentAssetRoot, storageEstimate } from "./assets.js";

const SLOT_KEY = "bossrush.slot";
const PENDING_KEY = "bossrush.pending";

const state = {
  slot: Number(localStorage.getItem(SLOT_KEY)) || 1,
  tab: "bosses",
  filter: "",
  instance: null,
};

const mib = (n) => `${(n / 1048576).toFixed(0)} MB`;
const sceneLabel = (scene) =>
  ARENAS.find((a) => a.scene === scene)?.name || scene;

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/* ------------------------------------------------------------------ shell -- */

let root, body, hud, tabBar, toast;

function buildShell() {
  tabBar = h("div", { class: "lx-tabs", role: "tablist" });
  body = h("div", { class: "lx-body" });

  const head = h(
    "div",
    { class: "lx-head" },
    h("h2", {}, "Silksong ", h("b", {}, "Boss Rush")),
    h("span", { class: "lx-spacer" }),
    h("label", { class: "lx-field" }, "Save slot", slotPicker()),
    h("button", { class: "lx-btn primary", onclick: hide }, "Back to game"),
  );

  root = h("div", { id: "launcher" }, head, tabBar, body);
  document.body.appendChild(root);

  hud = h("div", { id: "hud", hidden: "" });
  document.body.appendChild(hud);

  const tab = h(
    "button",
    { id: "launcher-tab", class: "lx-btn", onclick: show },
    "Boss Rush  ` ",
  );
  document.body.appendChild(tab);

  toast = h("div", { id: "toast", hidden: "" });
  document.body.appendChild(toast);

  for (const [id, label] of [
    ["bosses", "Bosses"],
    ["gauntlets", "Gauntlets"],
    ["rooms", "All rooms"],
    ["setup", "Setup"],
  ]) {
    tabBar.append(
      h(
        "button",
        {
          class: "lx-tab",
          role: "tab",
          "data-tab": id,
          onclick: () => {
            state.tab = id;
            render();
          },
        },
        label,
      ),
    );
  }
}

function slotPicker() {
  const sel = h("select", {
    onchange: (e) => {
      state.slot = Number(e.target.value);
      localStorage.setItem(SLOT_KEY, String(state.slot));
      render();
    },
  });
  for (const n of [1, 2, 3, 4]) {
    sel.append(h("option", { value: n, selected: n === state.slot ? "" : null }, n));
  }
  return sel;
}

function show() {
  root.hidden = false;
  document.getElementById("launcher-tab").hidden = true;
  render();
}

function hide() {
  root.hidden = true;
  document.getElementById("launcher-tab").hidden = false;
  document.querySelector("#unity-canvas")?.focus();
}

function say(message) {
  const box = h("div", { class: "lx-warn" }, message);
  body.prepend(box);
  body.scrollTop = 0;
}

/* ------------------------------------------------------------------- tabs -- */

function render() {
  for (const t of tabBar.querySelectorAll(".lx-tab")) {
    t.setAttribute("aria-selected", String(t.dataset.tab === state.tab));
  }
  body.replaceChildren();
  ({ bosses: renderBosses, gauntlets: renderGauntlets, rooms: renderRooms, setup: renderSetup })[
    state.tab
  ]();
}

function arenaCard(arena) {
  return h(
    "button",
    { class: "lx-card", onclick: () => launch([arena.scene], arena.name) },
    h("span", { class: "name" }, arena.name),
    h("span", { class: "meta" }, h("em", {}, arena.kind), " · ", arena.scene),
  );
}

function renderBosses() {
  const zones = new Map();
  for (const a of ARENAS) {
    if (!zones.has(a.zone)) zones.set(a.zone, []);
    zones.get(a.zone).push(a);
  }
  body.append(
    h(
      "div",
      { class: "lx-stat-row" },
      h("span", {}, h("b", {}, ARENAS.length), " arenas across ", h("b", {}, zones.size), " zones"),
      h("span", {}, "Pick one to drop straight into it."),
    ),
  );
  for (const [zone, list] of [...zones].sort()) {
    body.append(
      h("div", { class: "lx-section-title" }, zone),
      h("div", { class: "lx-grid" }, list.map(arenaCard)),
    );
  }
}

function renderGauntlets() {
  const run = warp.readRun();
  if (run && !run.finishedAt) {
    body.append(
      h(
        "div",
        { class: "lx-warn" },
        `Run in progress: ${run.label} — fight ${run.index + 1} of ${run.scenes.length} (${sceneLabel(
          run.scenes[run.index],
        )}). Press ] or use the bar at the top to move on once a fight is done.`,
      ),
      h(
        "div",
        { class: "lx-stat-row" },
        h("button", { class: "lx-btn primary", onclick: nextFight }, "Next fight"),
        h("button", { class: "lx-btn", onclick: endRun }, "End run"),
      ),
    );
  }

  body.append(h("div", { class: "lx-section-title" }, "Ready-made chains"));
  body.append(
    h(
      "div",
      { class: "lx-grid" },
      GAUNTLETS.map((g) =>
        h(
          "button",
          { class: "lx-card", onclick: () => launch(g.scenes, g.name) },
          h("span", { class: "name" }, g.name),
          h("span", { class: "meta" }, h("em", {}, `${g.scenes.length} fights`), " · ", g.blurb),
        ),
      ),
    ),
  );

  body.append(
    h("div", { class: "lx-section-title" }, "Build your own"),
    h(
      "p",
      { class: "lx-note" },
      "Tick arenas to chain them in the order you tick them, then start the run.",
    ),
  );

  const picked = [];
  const counter = h("span", {}, "0 picked");
  const grid = h(
    "div",
    { class: "lx-grid" },
    ARENAS.map((a) =>
      h(
        "button",
        {
          class: "lx-card",
          onclick: (e) => {
            const at = picked.indexOf(a.scene);
            if (at >= 0) picked.splice(at, 1);
            else picked.push(a.scene);
            e.currentTarget.style.borderLeftColor = at >= 0 ? "" : "var(--gold)";
            counter.textContent = `${picked.length} picked`;
          },
        },
        h("span", { class: "name" }, a.name),
        h("span", { class: "meta" }, a.scene),
      ),
    ),
  );
  body.append(
    h(
      "div",
      { class: "lx-stat-row" },
      counter,
      h(
        "button",
        {
          class: "lx-btn primary",
          onclick: () =>
            picked.length
              ? launch([...picked], "Custom gauntlet")
              : say("Pick at least one arena first."),
        },
        "Start custom run",
      ),
    ),
    grid,
  );
}

function renderRooms() {
  const input = h("input", {
    type: "search",
    placeholder: "Filter rooms…",
    value: state.filter,
    oninput: (e) => {
      state.filter = e.target.value;
      paint();
    },
  });
  const grid = h("div", { class: "lx-grid" });

  function paint() {
    const q = state.filter.trim().toLowerCase();
    const hits = ROOMS.filter(
      (r) => !q || r.scene.toLowerCase().includes(q) || r.zone.toLowerCase().includes(q),
    ).slice(0, 400);
    grid.replaceChildren(
      ...hits.map((r) =>
        h(
          "button",
          { class: "lx-card", onclick: () => launch([r.scene], r.scene) },
          h("span", { class: "name" }, r.scene),
          h("span", { class: "meta" }, r.zone),
        ),
      ),
    );
  }

  body.append(
    h(
      "p",
      { class: "lx-note" },
      `Every one of the ${ROOMS.length} rooms in the build, straight from the game's own asset catalog. `,
      "Handy if an arena entry drops you somewhere odd — the room next door usually works.",
    ),
    h("div", { class: "lx-stat-row" }, h("label", { class: "lx-field" }, "Search", input)),
    grid,
  );
  paint();
}

async function renderSetup() {
  const scale = storedRenderScale();
  const scaleSel = h(
    "select",
    {
      onchange: (e) => {
        applyRenderScale(Number(e.target.value), state.instance);
        say(`Rendering at ${Math.round(Number(e.target.value) * 100)}% resolution.`);
      },
    },
    [1.5, 1, 0.85, 0.75, 0.6, 0.5, 0.4].map((v) =>
      h(
        "option",
        { value: v, selected: v === scale ? "" : null },
        `${Math.round(v * 100)}%${v === 1 ? " (native)" : ""}`,
      ),
    ),
  );

  body.append(
    h("div", { class: "lx-section-title" }, "Performance"),
    h(
      "p",
      { class: "lx-note" },
      "Render scale is the strongest lever on framerate here — the game draws fewer pixels ",
      "but still fills the window. Drop it if fights feel heavy; it takes effect immediately.",
    ),
    h("div", { class: "lx-stat-row" }, h("label", { class: "lx-field" }, "Render scale", scaleSel)),
  );

  const est = await storageEstimate();
  const pulled = [...stats.bundles.values()].reduce((n, b) => n + b.compressed, 0);
  const root = currentAssetRoot();
  body.append(
    h("div", { class: "lx-section-title" }, "Downloads"),
    h(
      "div",
      { class: "lx-stat-row" },
      h("span", {}, "Game files from: ", h("b", {}, root ? new URL(root).host : "unknown")),
      h("span", {}, "Archived bundles pulled this session: ", h("b", {}, stats.bundles.size)),
      h("span", {}, "Bytes over the wire: ", h("b", {}, mib(pulled))),
      est ? h("span", {}, "Cached on disk: ", h("b", {}, mib(est.usage || 0))) : null,
    ),
    h(
      "p",
      { class: "lx-note" },
      "Assets are fetched only when the game asks for them and kept for next time, ",
      "so a session that only fights one boss never downloads the rest of the game.",
    ),
  );

  // --- save slot ---
  body.append(h("div", { class: "lx-section-title" }, `Save slot ${state.slot}`));
  const info = await warp.inspectSlot(state.slot);
  if (!info.exists) {
    body.append(
      h(
        "div",
        { class: "lx-warn" },
        info.reason === "no-save-dir"
          ? "Silksong has not written anything to storage yet. Give it a moment at the title screen, then reopen this tab."
          : `Slot ${state.slot} is empty. Start a game in Silksong once (any slot) so it writes a save file — ` +
            "Boss Rush edits that file rather than inventing one, which is why it can never corrupt a slot it did not write.",
      ),
    );
  } else {
    body.append(
      h(
        "div",
        { class: "lx-stat-row" },
        h("span", {}, "Size: ", h("b", {}, `${info.size} bytes`)),
        h("span", {}, "Format: ", h("b", {}, info.encrypted ? "encrypted" : "plain JSON")),
        info.respawnScene ? h("span", {}, "Respawns at: ", h("b", {}, info.respawnScene)) : null,
        info.completion !== undefined
          ? h("span", {}, "Completion: ", h("b", {}, `${info.completion}%`))
          : null,
      ),
    );
  }

  const result = h("p", { class: "lx-note" });
  body.append(
    h(
      "div",
      { class: "lx-stat-row" },
      h(
        "button",
        {
          class: "lx-btn",
          onclick: async () => {
            result.textContent = "Checking…";
            const r = await warp.verifyFormat(state.slot);
            result.textContent = `${r.ok ? "PASS" : "FAIL"} — ${r.reason}`;
            result.style.color = r.ok ? "var(--gold)" : "#ff8b8b";
          },
        },
        "Check save format",
      ),
      h(
        "button",
        {
          class: "lx-btn",
          onclick: async () => {
            try {
              await warp.restoreBackup(state.slot);
              result.textContent = "Restored the save as it was before the first warp. Reload to pick it up.";
              result.style.color = "var(--gold)";
            } catch (err) {
              result.textContent = err.message;
              result.style.color = "#ff8b8b";
            }
          },
        },
        "Restore pre-warp save",
      ),
    ),
    result,
    h(
      "p",
      { class: "lx-note" },
      "“Check save format” decodes your slot and re-encodes it, then compares the bytes. ",
      "A pass means a warp writes a file byte-for-byte like the game's own, apart from the ",
      "respawn fields it is meant to change. The first warp stashes your untouched save next to ",
      "the slot so “Restore” can always put it back.",
    ),
  );

  const markerInput = h("input", {
    type: "text",
    value: warp.storedMarker(),
    onchange: (e) => {
      warp.setMarker(e.target.value.trim());
      say(`Warps will look for an object named \u201c${warp.storedMarker()}\u201d.`);
    },
  });
  body.append(
    h("div", { class: "lx-section-title" }, "Advanced"),
    h(
      "p",
      { class: "lx-note" },
      "A save says which object in a room Hornet respawns at. Almost every room uses ",
      h("code", {}, "Death Respawn Marker"),
      ". If a particular arena drops you somewhere strange, try another name here, ",
      "or warp to the room next door from the All rooms tab.",
    ),
    h("div", { class: "lx-stat-row" }, h("label", { class: "lx-field" }, "Respawn marker", markerInput)),
  );

  body.append(
    h("div", { class: "lx-section-title" }, "How a warp works"),
    h(
      "p",
      { class: "lx-note" },
      "A compiled build will not load an arbitrary scene from the outside and still give you a ",
      "working hero, HUD and camera — only the game's own “continue” path sets all that up. ",
      "So Boss Rush points your save's ",
      h("code", {}, "respawnScene"),
      " at the arena you chose, then reloads the page. Continue your game and you wake up there. ",
      "Keys: ",
      h("code", {}, "`"),
      " opens this panel, ",
      h("code", {}, "]"),
      " moves to the next fight in a run.",
    ),
  );
}

/* ------------------------------------------------------------------- runs -- */

async function launch(scenes, label) {
  const info = await warp.inspectSlot(state.slot);
  if (!info.exists) {
    state.tab = "setup";
    render();
    say(
      `Slot ${state.slot} has no save yet. Start a game in Silksong once so it writes one, then pick your fight.`,
    );
    return;
  }
  try {
    if (scenes.length > 1) warp.startRun({ slot: state.slot, scenes, label });
    else warp.writeRun(null);
    await warp.warp(state.slot, scenes[0]);
    localStorage.setItem(PENDING_KEY, JSON.stringify({ scene: scenes[0], label }));
    location.reload();
  } catch (err) {
    say(err.message);
  }
}

async function nextFight() {
  const scene = warp.advanceRun();
  if (!scene) {
    const run = warp.readRun();
    endRun();
    say(
      run
        ? `Run finished: ${run.label}, ${run.scenes.length} fights in ${formatTime(
            (run.finishedAt || Date.now()) - run.startedAt,
          )}.`
        : "Run finished.",
    );
    return;
  }
  await warp.warp(state.slot, scene);
  localStorage.setItem(PENDING_KEY, JSON.stringify({ scene, label: sceneLabel(scene) }));
  location.reload();
}

function endRun() {
  warp.writeRun(null);
  paintHud();
  render();
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function paintHud() {
  const run = warp.readRun();
  if (!run || run.finishedAt) {
    hud.hidden = true;
    return;
  }
  hud.hidden = false;
  hud.replaceChildren(
    h("span", { class: "stage" }, `${run.index + 1}/${run.scenes.length}`),
    h("span", {}, sceneLabel(run.scenes[run.index])),
    h("span", { class: "timer" }, formatTime(Date.now() - run.startedAt)),
    h("span", { class: "timer" }, "]  next"),
  );
}

/* ------------------------------------------------------------------ mount -- */

export async function mountLauncher(instance) {
  state.instance = instance;
  buildShell();
  applyRenderScale(storedRenderScale(), instance);

  const pending = localStorage.getItem(PENDING_KEY);
  localStorage.removeItem(PENDING_KEY);

  paintHud();
  setInterval(paintHud, 1000);

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "`") {
      e.preventDefault();
      root.hidden ? show() : hide();
    } else if (e.key === "]" && warp.readRun()) {
      e.preventDefault();
      nextFight();
    }
  });

  if (pending) {
    // Came back from a warp: stay out of the way so the player can hit Continue.
    hide();
    const { label } = JSON.parse(pending);
    toast.hidden = false;
    toast.replaceChildren(
      h("span", { class: "stage" }, "Warped"),
      h("span", {}, `${label} — choose Continue in the menu`),
    );
    setTimeout(() => (toast.hidden = true), 12000);
  } else {
    show();
  }

  window.__bossrush = { warp, state, show, hide };
}
