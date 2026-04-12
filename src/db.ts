import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";

const DB_PATH = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, "subathon.db")
  : join(import.meta.dir, "..", "subathon.db");
const LEGACY_CHECKPOINT_PATH = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, "fruitberries-checkpoint.json")
  : join(import.meta.dir, "..", "fruitberries-checkpoint.json");

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_trackers (
    session_id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS seen_sub_ids (
    id TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS seen_bit_ids (
    id TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS counters (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gifters (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    id TEXT,
    gifts INTEGER NOT NULL
  );
`);

const upsertConfigStmt = db.query("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
const getConfigStmt = db.query("SELECT value FROM config WHERE key = ?");
const deleteConfigStmt = db.query("DELETE FROM config WHERE key = ?");
const upsertSessionTrackerStmt = db.query("INSERT INTO session_trackers (session_id, expires_at, data) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data");
const getSessionTrackerStmt = db.query("SELECT expires_at, data FROM session_trackers WHERE session_id = ?");
const getAllSessionTrackersStmt = db.query("SELECT session_id, expires_at, data FROM session_trackers");
const deleteSessionTrackerStmt = db.query("DELETE FROM session_trackers WHERE session_id = ?");
const deleteExpiredSessionTrackersStmt = db.query("DELETE FROM session_trackers WHERE expires_at > 0 AND expires_at <= ?");
const insertSeenSubStmt = db.query("INSERT OR IGNORE INTO seen_sub_ids (id) VALUES (?)");
const insertSeenBitStmt = db.query("INSERT OR IGNORE INTO seen_bit_ids (id) VALUES (?)");
const clearSeenSubsStmt = db.query("DELETE FROM seen_sub_ids");
const clearSeenBitsStmt = db.query("DELETE FROM seen_bit_ids");
const initCounterStmt = db.query("INSERT OR IGNORE INTO counters (key, value) VALUES (?, 0)");
const setCounterStmt = db.query("INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
const getAllCountersStmt = db.query("SELECT key, value FROM counters");
const clearGiftersStmt = db.query("DELETE FROM gifters");
const getAllGiftersStmt = db.query("SELECT key, name, id, gifts FROM gifters");
const upsertGifterStmt = db.query("INSERT INTO gifters (key, name, id, gifts) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, id = excluded.id, gifts = excluded.gifts");

const config = new Map<string, string>();
let trackedSubs = 0;
let trackedBits = 0;
let giftedSubs = 0;
const gifterCounts = new Map<string, { name: string; id: string | null; gifts: number }>();
const FRUITBERRIES_GIFTER_SEED = [
  ["4x6xj", 50],
  ["chlorop1ast", 37],
  ["relaysslive", 22],
  ["ozcanaliburak", 20],
  ["SophiaMantequilla", 19],
  ["kristachubs", 10],
  ["CupcakeGaming882", 10],
  ["kqmad0", 5],
  ["JohnDubuc", 5],
  ["chandylire", 5],
] as const;
const FRUITBERRIES_BITS_SEED = [
  ["CommanderXander_", 1000],
  ["valentrines", 245],
  ["RedVaporeonYt", 195],
  ["chlorop1ast", 100],
  ["mdad1427", 100],
  ["1cubealot_", 100],
  ["Eken321", 100],
  ["minhduc12b", 93],
  ["naurtilus", 30],
] as const;

function initCounters() {
  initCounterStmt.run("trackedSubs");
  initCounterStmt.run("trackedBits");
  initCounterStmt.run("giftedSubs");
}

function migrateLegacyCheckpoint() {
  if (db.query("SELECT COUNT(*) AS count FROM config").get()!.count) return;
  if (!existsSync(LEGACY_CHECKPOINT_PATH)) return;
  try {
    const raw = readFileSync(LEGACY_CHECKPOINT_PATH, "utf8");
    const data = JSON.parse(raw) as {
      config?: Record<string, string>;
      counters?: { trackedSubs?: number; trackedBits?: number; giftedSubs?: number };
      gifters?: { key: string; name: string; id: string | null; gifts: number }[];
    };
    const tx = db.transaction(() => {
      for (const [key, value] of Object.entries(data.config ?? {})) {
        upsertConfigStmt.run(key, value);
      }
      setCounterStmt.run("trackedSubs", data.counters?.trackedSubs ?? 0);
      setCounterStmt.run("trackedBits", data.counters?.trackedBits ?? 0);
      setCounterStmt.run("giftedSubs", data.counters?.giftedSubs ?? 0);
      clearGiftersStmt.run();
      for (const gifter of data.gifters ?? []) {
        upsertGifterStmt.run(gifter.key, gifter.name, gifter.id, gifter.gifts);
      }
    });
    tx();
    rmSync(LEGACY_CHECKPOINT_PATH, { force: true });
  } catch {}
}

function loadState() {
  config.clear();
  for (const row of db.query("SELECT key, value FROM config").all() as { key: string; value: string }[]) {
    config.set(row.key, row.value);
  }

  const counters = new Map(
    (getAllCountersStmt.all() as { key: string; value: number }[]).map((row) => [row.key, row.value])
  );
  trackedSubs = counters.get("trackedSubs") ?? 0;
  trackedBits = counters.get("trackedBits") ?? 0;
  giftedSubs = counters.get("giftedSubs") ?? 0;

  gifterCounts.clear();
  for (const row of getAllGiftersStmt.all() as { key: string; name: string; id: string | null; gifts: number }[]) {
    gifterCounts.set(row.key, { name: row.name, id: row.id, gifts: row.gifts });
  }
}

function seedFruitberriesGifters() {
  if (config.get("fruitberries_gifter_seed_v2") === "1") return;
  const seedTotal = FRUITBERRIES_GIFTER_SEED.reduce((sum, [, gifts]) => sum + gifts, 0);
  const tx = db.transaction(() => {
    clearGiftersStmt.run();
    gifterCounts.clear();
    for (const [name, gifts] of FRUITBERRIES_GIFTER_SEED) {
      const key = `manual:${name.toLowerCase()}`;
      const current = { name, id: null, gifts };
      gifterCounts.set(key, current);
      upsertGifterStmt.run(key, current.name, current.id, current.gifts);
    }
    giftedSubs = seedTotal;
    persistCounter("giftedSubs", giftedSubs);
    upsertConfigStmt.run("fruitberries_gifter_seed_v2", "1");
    config.set("fruitberries_gifter_seed_v2", "1");
  });
  tx();
}

function seedFruitberriesBits() {
  if (config.get("fruitberries_bits_seed_v2") === "1") return;
  const seedTotal = FRUITBERRIES_BITS_SEED.reduce((sum, [, bits]) => sum + bits, 0);
  const tx = db.transaction(() => {
    trackedBits = seedTotal;
    persistCounter("trackedBits", trackedBits);
    upsertConfigStmt.run("fruitberries_bits_seed_v2", "1");
    config.set("fruitberries_bits_seed_v2", "1");
  });
  tx();
}

initCounters();
migrateLegacyCheckpoint();
loadState();
seedFruitberriesGifters();
seedFruitberriesBits();

function persistCounter(key: string, value: number) {
  setCounterStmt.run(key, value);
}

export function syncFruitberriesCheckpoint(): void {}

export function getConfig(key: string): string | null {
  return config.get(key) ?? null;
}

export function setConfig(key: string, value: string): void {
  config.set(key, value);
  upsertConfigStmt.run(key, value);
}

export function deleteConfigKeys(keys: string[]): void {
  for (const key of keys) {
    config.delete(key);
    deleteConfigStmt.run(key);
  }
}

export function clearTrackedEvents(): void {
  trackedSubs = 0;
  trackedBits = 0;
  giftedSubs = 0;
  gifterCounts.clear();
  const tx = db.transaction(() => {
    clearSeenSubsStmt.run();
    clearSeenBitsStmt.run();
    clearGiftersStmt.run();
    persistCounter("trackedSubs", 0);
    persistCounter("trackedBits", 0);
    persistCounter("giftedSubs", 0);
  });
  tx();
}

export function getSubathonStart(): number {
  const val = getConfig("subathon_start");
  return val ? parseInt(val, 10) : 0;
}

export interface Stats {
  totalSubs: number;
  totalBits: number;
  giftedSubs: number;
  gifters: { name: string; id: string | null; gifts: number; rank: string; rankBase: string }[];
  subathonStart: number;
  baselineSubs: number;
  connected: boolean;
}

export interface PersistedSessionTracker {
  sessionId: string;
  channel: string;
  channelDisplay: string;
  channelAvatar: string;
  authToken: string;
  refreshToken: string | null;
  broadcasterId: string;
  streamStatus: { live: boolean; title: string; viewers: number; startedAt: number };
  wasLive: boolean;
  sawOfflineSinceActivation: boolean;
  subathonStart: number;
  trackingMode: string;
  baselineSubs: number;
  trackedSubs: number;
  trackedBits: number;
  giftedSubs: number;
  gifters: { key: string; name: string; id: string | null; gifts: number }[];
  seenSubIds: string[];
  seenBitIds: string[];
  createdAt: number;
  expiresAt: number;
}

export function giftRankBase(gifts: number): string {
  if (gifts >= 100) return "oiler";
  if (gifts >= 75) return "netherite";
  if (gifts >= 50) return "diamond";
  if (gifts >= 30) return "emerald";
  if (gifts >= 15) return "gold";
  if (gifts >= 5) return "iron";
  return "coal";
}

function subdividedRank(base: string, gifts: number, min: number, max: number): string {
  const step = Math.ceil((max - min + 1) / 3);
  const idx = Math.min(2, Math.floor((gifts - min) / step));
  const suffix = ["i", "ii", "iii"][idx];
  return `${base} ${suffix}`;
}

export function giftRankLabel(gifts: number): string {
  const base = giftRankBase(gifts);
  if (base === "oiler") return base;
  if (base === "netherite") return subdividedRank(base, gifts, 75, 99);
  if (base === "diamond") return subdividedRank(base, gifts, 50, 74);
  if (base === "emerald") return subdividedRank(base, gifts, 30, 49);
  if (base === "gold") return subdividedRank(base, gifts, 15, 29);
  if (base === "iron") return subdividedRank(base, gifts, 5, 14);
  return subdividedRank(base, gifts, 1, 4);
}

export function getStats(connected = false): Stats {
  const baselineSubs = parseInt(getConfig("baseline_subs") ?? "0", 10);
  const mergedGifters = new Map<string, { name: string; id: string | null; gifts: number }>();
  for (const gifter of gifterCounts.values()) {
    const key = gifter.name.trim().toLowerCase();
    const current = mergedGifters.get(key) ?? { name: gifter.name, id: gifter.id, gifts: 0 };
    current.gifts += gifter.gifts;
    if (!current.id && gifter.id) current.id = gifter.id;
    mergedGifters.set(key, current);
  }
  const gifters = [...mergedGifters.values()]
    .sort((a, b) => b.gifts - a.gifts || a.name.localeCompare(b.name))
    .slice(0, 50)
    .map((gifter) => ({
      ...gifter,
      rankBase: giftRankBase(gifter.gifts),
      rank: giftRankLabel(gifter.gifts),
    }));

  return {
    totalSubs: trackedSubs,
    totalBits: trackedBits,
    giftedSubs,
    gifters,
    subathonStart: getSubathonStart(),
    baselineSubs,
    connected,
  };
}

export function addSubEvent(event: {
  id: string;
  userId: string;
  userName: string;
  tier: string;
  isGift: boolean;
  gifterId?: string | null;
  gifterName?: string | null;
}) {
  const inserted = insertSeenSubStmt.run(event.id);
  if (!inserted.changes) return;

  trackedSubs += 1;
  const tx = db.transaction(() => {
    persistCounter("trackedSubs", trackedSubs);
    if (!event.isGift) return;
    giftedSubs += 1;
    persistCounter("giftedSubs", giftedSubs);
    const key = `${event.gifterId ?? "anon"}:${event.gifterName ?? "Anonymous"}`;
    const current = gifterCounts.get(key) ?? {
      name: event.gifterName ?? "Anonymous",
      id: event.gifterId ?? null,
      gifts: 0,
    };
    current.gifts += 1;
    gifterCounts.set(key, current);
    upsertGifterStmt.run(key, current.name, current.id, current.gifts);
  });
  tx();
}

export function addBitEvent(event: {
  id: string;
  userId: string | null;
  userName: string | null;
  bits: number;
}) {
  const inserted = insertSeenBitStmt.run(event.id);
  if (!inserted.changes) return;
  trackedBits += event.bits;
  persistCounter("trackedBits", trackedBits);
}

export function saveSessionTracker(state: PersistedSessionTracker): void {
  upsertSessionTrackerStmt.run(state.sessionId, state.expiresAt, JSON.stringify(state));
}

export function loadSessionTracker(sessionId: string): PersistedSessionTracker | null {
  const row = getSessionTrackerStmt.get(sessionId) as { expires_at: number; data: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as PersistedSessionTracker;
  } catch {
    deleteSessionTrackerStmt.run(sessionId);
    return null;
  }
}

export function listSessionTrackers(): PersistedSessionTracker[] {
  const states: PersistedSessionTracker[] = [];
  for (const row of getAllSessionTrackersStmt.all() as { session_id: string; expires_at: number; data: string }[]) {
    try {
      states.push(JSON.parse(row.data) as PersistedSessionTracker);
    } catch {
      deleteSessionTrackerStmt.run(row.session_id);
    }
  }
  return states;
}

export function deleteSessionTracker(sessionId: string): void {
  deleteSessionTrackerStmt.run(sessionId);
}

export function deleteExpiredSessionTrackers(now: number): void {
  deleteExpiredSessionTrackersStmt.run(now);
}
