/*
 * save.js - read and write Silksong save slots from the browser.
 *
 * Silksong stores saves exactly the way Hollow Knight did:
 *
 *   JSON  ->  AES-256-ECB / PKCS7  ->  base64  ->  .NET BinaryFormatter string
 *
 * The encryption is not assumed: the build's GameConfig asset
 * (packed-gameconfig_assets_all_*.bundle) carries useSaveEncryption = 1, and
 * the key below is the literal sitting in the IL2CPP metadata.
 *
 * In a WebGL build those bytes live in the Emscripten IDBFS mirror, an
 * IndexedDB database named "/idbfs" whose FILE_DATA store is keyed by absolute
 * path (".../user1.dat"). Reading and rewriting that record is all a warp
 * needs: the game reloads the slot and drops Hornet wherever respawnScene says.
 *
 * We deliberately never synthesise a save from nothing - we patch one the game
 * itself wrote, so every field we don't understand keeps its real value.
 */

const KEY = "UKu52ePUBwetZ9wNX88o54dnfKRu0T1l"; // 32 bytes -> AES-256
const DB_NAME = "/idbfs";
const STORE = "FILE_DATA";
const DB_VERSION = 21;

/* ------------------------------------------------------------------ AES -- */
/*
 * WebCrypto has no ECB mode. Decryption is still cheap: CBC with a zero IV
 * gives P[i] = D(C[i]) ^ C[i-1], so one CBC pass plus an XOR recovers ECB.
 * Encryption can't be reduced that way, so the cipher below does that half.
 */

const SBOX = new Uint8Array(256);
const RCON = new Uint8Array([0x8d, 1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d]);

(function buildSbox() {
  // p[i] = 3^i and l[v] = log_3(v) in GF(2^8); the S-box is the multiplicative
  // inverse run through the affine transform.
  const p = new Uint8Array(256);
  const l = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    p[i] = x;
    l[x] = i;
    x ^= ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff;
    x &= 0xff;
  }
  SBOX[0] = 0x63;
  for (let v = 1; v < 256; v++) {
    const inv = p[(255 - l[v]) % 255];
    let s = inv;
    let y = inv;
    for (let k = 0; k < 4; k++) {
      y = ((y << 1) | (y >>> 7)) & 0xff;
      s ^= y;
    }
    SBOX[v] = s ^ 0x63;
  }
})();

function xtime(a) {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}

function expandKey(keyBytes) {
  const Nk = 8; // 256-bit
  const Nr = 14;
  const w = new Uint8Array(16 * (Nr + 1));
  w.set(keyBytes.subarray(0, 32));
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    let a = w[(i - 1) * 4],
      b = w[(i - 1) * 4 + 1],
      c = w[(i - 1) * 4 + 2],
      d = w[(i - 1) * 4 + 3];
    if (i % Nk === 0) {
      [a, b, c, d] = [SBOX[b] ^ RCON[i / Nk], SBOX[c], SBOX[d], SBOX[a]];
    } else if (i % Nk === 4) {
      [a, b, c, d] = [SBOX[a], SBOX[b], SBOX[c], SBOX[d]];
    }
    w[i * 4] = w[(i - Nk) * 4] ^ a;
    w[i * 4 + 1] = w[(i - Nk) * 4 + 1] ^ b;
    w[i * 4 + 2] = w[(i - Nk) * 4 + 2] ^ c;
    w[i * 4 + 3] = w[(i - Nk) * 4 + 3] ^ d;
  }
  return w;
}

function encryptBlock(state, w) {
  const Nr = 14;
  for (let i = 0; i < 16; i++) state[i] ^= w[i];
  for (let round = 1; round <= Nr; round++) {
    for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]];
    // ShiftRows (column-major AES state: byte r + 4c)
    let t = state[1];
    state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t;
    t = state[2]; state[2] = state[10]; state[10] = t;
    t = state[6]; state[6] = state[14]; state[14] = t;
    t = state[15];
    state[15] = state[11]; state[11] = state[7]; state[7] = state[3]; state[3] = t;
    if (round !== Nr) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = state[c], a1 = state[c + 1], a2 = state[c + 2], a3 = state[c + 3];
        const all = a0 ^ a1 ^ a2 ^ a3;
        state[c] ^= all ^ xtime(a0 ^ a1);
        state[c + 1] ^= all ^ xtime(a1 ^ a2);
        state[c + 2] ^= all ^ xtime(a2 ^ a3);
        state[c + 3] ^= all ^ xtime(a3 ^ a0);
      }
    }
    for (let i = 0; i < 16; i++) state[i] ^= w[round * 16 + i];
  }
  return state;
}

const keyBytes = new TextEncoder().encode(KEY);
const SCHEDULE = expandKey(keyBytes);

/** One raw 16-byte ECB block, no padding. */
function ecbBlock(input) {
  return encryptBlock(Uint8Array.from(input), SCHEDULE);
}

export function aesEcbEncrypt(plain) {
  const pad = 16 - (plain.length % 16); // PKCS7 always adds 1..16 bytes
  const out = new Uint8Array(plain.length + pad);
  out.set(plain);
  out.fill(pad, plain.length);
  const block = new Uint8Array(16);
  for (let off = 0; off < out.length; off += 16) {
    block.set(out.subarray(off, off + 16));
    out.set(encryptBlock(block, SCHEDULE), off);
  }
  return out;
}

/**
 * ECB decryption on top of WebCrypto's CBC. With a zero IV, CBC yields
 * P[i] = D(C[i]) ^ C[i-1], so XORing the previous ciphertext block back off
 * each plaintext block recovers plain ECB - one native pass over the whole
 * buffer instead of a JS block loop.
 *
 * WebCrypto insists the final block carry valid PKCS7, so we append a block
 * crafted to decrypt to 0x10 x16 and drop it afterwards.
 */
export async function aesEcbDecrypt(cipher) {
  if (cipher.length === 0 || cipher.length % 16) throw new Error("bad ciphertext length");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["decrypt"]);

  const tail = new Uint8Array(16).fill(0x10);
  for (let i = 0; i < 16; i++) tail[i] ^= cipher[cipher.length - 16 + i];
  const probe = new Uint8Array(cipher.length + 16);
  probe.set(cipher);
  probe.set(ecbBlock(tail), cipher.length);

  const out = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, key, probe),
  );
  for (let off = out.length - 16; off >= 16; off -= 16) {
    for (let i = 0; i < 16; i++) out[off + i] ^= cipher[off - 16 + i];
  }
  const padLen = out[out.length - 1];
  if (padLen < 1 || padLen > 16) throw new Error("bad PKCS7 padding");
  return out.subarray(0, out.length - padLen);
}

/* -------------------------------------------------- BinaryFormatter frame -- */

const BF_HEADER = new Uint8Array([
  0, 1, 0, 0, 0, 255, 255, 255, 255, 1, 0, 0, 0, 0, 0, 0, 0, 6, 1, 0, 0, 0,
]);
const BF_FOOTER = 0x0b;

function read7BitLength(bytes, start) {
  let value = 0;
  let shift = 0;
  let i = start;
  for (;;) {
    const b = bytes[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value, next: i };
}

function write7BitLength(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

/** true when the bytes carry the .NET BinaryFormatter string wrapper. */
export function isWrapped(bytes) {
  if (bytes.length < BF_HEADER.length) return false;
  for (let i = 0; i < BF_HEADER.length; i++) if (bytes[i] !== BF_HEADER[i]) return false;
  return true;
}

/** Raw save bytes -> the decrypted JSON text. */
export async function decodeSave(bytes) {
  if (!isWrapped(bytes)) return new TextDecoder().decode(bytes); // unencrypted slot
  const { value: len, next } = read7BitLength(bytes, BF_HEADER.length);
  const b64 = new TextDecoder().decode(bytes.subarray(next, next + len));
  const cipher = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(await aesEcbDecrypt(cipher));
}

/** JSON text -> raw save bytes in the game's own format. */
export function encodeSave(json, { encrypted = true } = {}) {
  const plain = new TextEncoder().encode(json);
  if (!encrypted) return plain;
  const cipher = aesEcbEncrypt(plain);
  let bin = "";
  for (let i = 0; i < cipher.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, cipher.subarray(i, i + 0x8000));
  }
  const b64 = new TextEncoder().encode(btoa(bin));
  const lenBytes = write7BitLength(b64.length);
  const out = new Uint8Array(BF_HEADER.length + lenBytes.length + b64.length + 1);
  out.set(BF_HEADER, 0);
  out.set(lenBytes, BF_HEADER.length);
  out.set(b64, BF_HEADER.length + lenBytes.length);
  out[out.length - 1] = BF_FOOTER;
  return out;
}

/* ----------------------------------------------------------------- IDBFS -- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE], mode);
    const store = t.objectStore(STORE);
    let result;
    fn(store, (v) => (result = v));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Every path currently mirrored in the persistent filesystem. */
export async function listPaths() {
  const db = await openDb();
  try {
    return await tx(db, "readonly", (store, done) => {
      const req = store.getAllKeys();
      req.onsuccess = () => done(req.result.map(String));
    });
  } finally {
    db.close();
  }
}

/**
 * Where the game keeps its saves. Unity mounts persistentDataPath under
 * /idbfs/<hash>, and the hash depends on the build, so we find it rather than
 * assume it.
 */
export async function findSaveDir(paths) {
  const all = paths || (await listPaths());
  for (const p of all) {
    const m = /^(\/idbfs\/[^/]+)\/user\d+\.dat$/.exec(p);
    if (m) return m[1];
  }
  for (const p of all) {
    const m = /^(\/idbfs\/[^/]+)\//.exec(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * Slots that hold an actual save. A zero-length user<N>.dat is a slot the game
 * treats as empty, so matching the filename alone would report saves that
 * aren't there.
 */
export async function listSlots() {
  const paths = await listPaths();
  const found = [];
  for (const p of paths) {
    const m = /^\/idbfs\/[^/]+\/user(\d+)\.dat$/.exec(p);
    if (!m) continue;
    const bytes = await readFile(p);
    if (!bytes || bytes.length === 0) continue;
    found.push({ slot: Number(m[1]), path: p, size: bytes.length });
  }
  return found.sort((a, b) => a.slot - b.slot);
}

/** Remove a slot's file entirely, so the game sees an empty profile again. */
export async function clearSlot(slot) {
  const dir = await findSaveDir();
  if (!dir) return false;
  const db = await openDb();
  try {
    await tx(db, "readwrite", (store) => store.delete(`${dir}/user${slot}.dat`));
  } finally {
    db.close();
  }
  return true;
}

export async function readFile(path) {
  const db = await openDb();
  try {
    const rec = await tx(db, "readonly", (store, done) => {
      const req = store.get(path);
      req.onsuccess = () => done(req.result);
    });
    if (!rec) return null;
    const c = rec.contents;
    return c instanceof Uint8Array ? c : new Uint8Array(c);
  } finally {
    db.close();
  }
}

export async function writeFile(path, bytes) {
  const db = await openDb();
  try {
    await tx(db, "readwrite", (store) => {
      store.put({ timestamp: new Date(), mode: 33206, contents: bytes }, path);
    });
  } finally {
    db.close();
  }
}

/** Read slot N and hand back both the parsed save and the bytes it came from. */
export async function loadSlot(slot) {
  const dir = await findSaveDir();
  if (!dir) return null;
  const path = `${dir}/user${slot}.dat`;
  const bytes = await readFile(path);
  if (!bytes) return null;
  const json = await decodeSave(bytes);
  return { path, bytes, json, data: JSON.parse(json), encrypted: isWrapped(bytes) };
}

export async function saveSlot(slot, data, { encrypted = true } = {}) {
  const dir = await findSaveDir();
  if (!dir) throw new Error("no save directory yet - start the game once first");
  const path = `${dir}/user${slot}.dat`;
  const json = typeof data === "string" ? data : JSON.stringify(data);
  await writeFile(path, encodeSave(json, { encrypted }));
  return path;
}
