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

initCounters();
migrateLegacyCheckpoint();
loadState();

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
  gifters: { name: string; id: string | null; gifts: number; rank: string }[];
  subathonStart: number;
  baselineSubs: number;
  connected: boolean;
}

function giftRank(gifts: number): string {
  if (gifts >= 100) return "diamond";
  if (gifts >= 50) return "platinum";
  if (gifts >= 25) return "gold";
  if (gifts >= 10) return "silver";
  if (gifts >= 5) return "bronze";
  return "member";
}

export function getStats(connected = false): Stats {
  const baselineSubs = parseInt(getConfig("baseline_subs") ?? "0", 10);
  const gifters = [...gifterCounts.values()]
    .sort((a, b) => b.gifts - a.gifts || a.name.localeCompare(b.name))
    .slice(0, 50)
    .map((gifter) => ({ ...gifter, rank: giftRank(gifter.gifts) }));

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
