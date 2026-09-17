/*
 * warp.js - drop Hornet into a chosen room.
 *
 * There is no way to make a compiled Unity build load an arbitrary scene from
 * the outside and still have a working hero, HUD and camera: the game only
 * sets all that up along its own "continue a save" path. So a warp is a save
 * edit. We take the slot the game itself wrote, change where it says Hornet
 * respawns, write it back in the same format, and reload the page - from the
 * game's point of view nothing unusual happened.
 *
 * The original bytes are kept alongside the slot so a run can always be undone.
 */

import * as save from "./save.js";

/*
 * The name of the object a save's respawn points at. "Death Respawn Marker" is
 * the one the build uses by default - it appears in the binary alongside the
 * "<scene> does not have a Death Respawn Marker Set" warning - but a scene can
 * name its marker differently, so it stays overridable.
 */
export const DEFAULT_MARKER = "Death Respawn Marker";
const MARKER_KEY = "bossrush.marker";
const BACKUP_PREFIX = "bossrush_backup_user";

export function storedMarker() {
  return localStorage.getItem(MARKER_KEY) || DEFAULT_MARKER;
}

export function setMarker(name) {
  if (name && name !== DEFAULT_MARKER) localStorage.setItem(MARKER_KEY, name);
  else localStorage.removeItem(MARKER_KEY);
}

/** What we know about a slot without changing anything. */
export async function inspectSlot(slot) {
  const dir = await save.findSaveDir();
  if (!dir) return { exists: false, reason: "no-save-dir" };

  const path = `${dir}/user${slot}.dat`;
  const bytes = await save.readFile(path);
  if (!bytes) return { exists: false, reason: "no-slot", dir, path };

  const info = { exists: true, dir, path, size: bytes.length, encrypted: save.isWrapped(bytes) };
  try {
    const json = await save.decodeSave(bytes);
    const data = JSON.parse(json);
    const pd = data.playerData || {};
    Object.assign(info, {
      data,
      respawnScene: pd.respawnScene,
      respawnMarkerName: pd.respawnMarkerName,
      completion: pd.completionPercentage,
      playTime: pd.playTime,
      health: pd.maxHealth ?? pd.health,
    });
  } catch (err) {
    info.error = err.message;
  }
  return info;
}

/**
 * Prove our codec matches the game's for this particular save: decode the
 * bytes the game wrote, re-encode them, and require the result to be identical.
 * If this passes, a warp writes a file the game will read back exactly as it
 * wrote it, except for the fields we meant to change.
 */
export async function verifyFormat(slot) {
  const dir = await save.findSaveDir();
  if (!dir) return { ok: false, reason: "No save directory yet." };
  const path = `${dir}/user${slot}.dat`;
  const bytes = await save.readFile(path);
  if (!bytes) return { ok: false, reason: `Slot ${slot} is empty.` };

  try {
    const json = await save.decodeSave(bytes);
    JSON.parse(json); // must be real JSON, not garbage that happened to decrypt
    const round = save.encodeSave(json, { encrypted: save.isWrapped(bytes) });
    const identical =
      round.length === bytes.length && round.every((b, i) => b === bytes[i]);
    return {
      ok: identical,
      encrypted: save.isWrapped(bytes),
      size: bytes.length,
      jsonSize: json.length,
      reason: identical
        ? "Decoded and re-encoded to byte-identical output."
        : `Re-encode differs (${round.length} vs ${bytes.length} bytes).`,
    };
  } catch (err) {
    return { ok: false, reason: `Could not decode slot ${slot}: ${err.message}` };
  }
}

async function backupPath(slot) {
  const dir = await save.findSaveDir();
  return `${dir}/${BACKUP_PREFIX}${slot}.dat`;
}

export async function hasBackup(slot) {
  return !!(await save.readFile(await backupPath(slot)));
}

/** Keep the first pre-warp state we ever see; later warps must not overwrite it. */
async function ensureBackup(slot, bytes) {
  const path = await backupPath(slot);
  if (!(await save.readFile(path))) await save.writeFile(path, bytes);
}

export async function restoreBackup(slot) {
  const path = await backupPath(slot);
  const bytes = await save.readFile(path);
  if (!bytes) throw new Error("no backup stored for this slot");
  const dir = await save.findSaveDir();
  await save.writeFile(`${dir}/user${slot}.dat`, bytes);
  return true;
}

/**
 * Point a slot's respawn at `scene`. Returns the fields as written so the UI
 * can show exactly what changed.
 */
export async function warp(slot, scene, opts = {}) {
  const dir = await save.findSaveDir();
  if (!dir) throw new Error("Silksong has not created a save folder yet.");

  const path = `${dir}/user${slot}.dat`;
  const bytes = await save.readFile(path);
  if (!bytes) {
    throw new Error(
      `Slot ${slot} is empty. Start a game in Silksong once so it writes a save, then come back.`,
    );
  }

  const encrypted = save.isWrapped(bytes);
  const data = JSON.parse(await save.decodeSave(bytes));
  if (!data.playerData) throw new Error("save has no playerData block");

  await ensureBackup(slot, bytes);

  const patch = {
    respawnScene: scene,
    respawnMarkerName: opts.marker || storedMarker(),
    respawnType: opts.respawnType ?? 0, // 0 = respawn marker, 1 = bench
    respawnFacingRight: opts.facingRight ?? true,
  };
  // If the save remembers Hornet sitting on a bench, clear it - the arena we
  // are sending her to has no bench to sit on. Only keys the save already
  // carries are touched, so we never invent fields this build does not read.
  for (const key of ["atBench", "AtBench", "atBenchSitting"]) {
    if (key in data.playerData) patch[key] = false;
  }
  Object.assign(data.playerData, patch);

  await save.writeFile(path, save.encodeSave(JSON.stringify(data), { encrypted }));
  return { path, encrypted, patch };
}

/* ------------------------------------------------------------ run state -- */

const STATE_KEY = "bossrush.run";

export function readRun() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY)) || null;
  } catch {
    return null;
  }
}

export function writeRun(run) {
  if (run) localStorage.setItem(STATE_KEY, JSON.stringify(run));
  else localStorage.removeItem(STATE_KEY);
}

export function startRun({ slot, scenes, label }) {
  const run = {
    slot,
    scenes,
    label,
    index: 0,
    startedAt: Date.now(),
    splits: [],
  };
  writeRun(run);
  return run;
}

/** Advance the run; returns the next scene, or null when the chain is done. */
export function advanceRun() {
  const run = readRun();
  if (!run) return null;
  run.splits.push(Date.now());
  run.index += 1;
  if (run.index >= run.scenes.length) {
    run.finishedAt = Date.now();
    writeRun(run);
    return null;
  }
  writeRun(run);
  return run.scenes[run.index];
}
