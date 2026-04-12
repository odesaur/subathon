import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const CHECKPOINT_PATH = process.env.DATA_DIR
  ? join(process.env.DATA_DIR, "fruitberries-checkpoint.json")
  : join(import.meta.dir, "..", "fruitberries-checkpoint.json");
const CHECKPOINT_CHANNEL = "fruitberries";
const CHECKPOINT_KEYS = [
  "channel_login",
  "channel_display_name",
  "channel_avatar",
  "subathon_start",
  "baseline_subs",
  "broadcaster_token",
  "broadcaster_id",
  "broadcaster_refresh",
  "tracking_mode",
];

const config = new Map<string, string>();
const seenSubIds = new Set<string>();
const seenBitIds = new Set<string>();
let trackedSubs = 0;
let trackedBits = 0;
let giftedSubs = 0;
const gifterCounts = new Map<string, { name: string; id: string | null; gifts: number }>();

function shouldPersistCheckpoint() {
  return getConfig("channel_login") === CHECKPOINT_CHANNEL;
}

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_PATH)) return;
  try {
    const raw = readFileSync(CHECKPOINT_PATH, "utf8");
    const data = JSON.parse(raw) as {
      config?: Record<string, string>;
      counters?: { trackedSubs?: number; trackedBits?: number; giftedSubs?: number };
      gifters?: { key: string; name: string; id: string | null; gifts: number }[];
    };
    for (const [key, value] of Object.entries(data.config ?? {})) {
      config.set(key, value);
    }
    trackedSubs = data.counters?.trackedSubs ?? 0;
    trackedBits = data.counters?.trackedBits ?? 0;
    giftedSubs = data.counters?.giftedSubs ?? 0;
    gifterCounts.clear();
    for (const gifter of data.gifters ?? []) {
      gifterCounts.set(gifter.key, { name: gifter.name, id: gifter.id, gifts: gifter.gifts });
    }
  } catch {}
}

loadCheckpoint();

export function syncFruitberriesCheckpoint(): void {
  if (!shouldPersistCheckpoint()) {
    try { rmSync(CHECKPOINT_PATH, { force: true }); } catch {}
    return;
  }
  const persistedConfig = Object.fromEntries(
    [...config.entries()].filter(([key]) => CHECKPOINT_KEYS.includes(key))
  );
  const payload = {
    config: persistedConfig,
    counters: { trackedSubs, trackedBits, giftedSubs },
    gifters: [...gifterCounts.entries()].map(([key, gifter]) => ({ key, ...gifter })),
  };
  try {
    writeFileSync(CHECKPOINT_PATH, JSON.stringify(payload), "utf8");
  } catch {}
}

export function getConfig(key: string): string | null {
  return config.get(key) ?? null;
}

export function setConfig(key: string, value: string): void {
  config.set(key, value);
}

export function deleteConfigKeys(keys: string[]): void {
  for (const key of keys) config.delete(key);
}

export function clearTrackedEvents(): void {
  seenSubIds.clear();
  seenBitIds.clear();
  trackedSubs = 0;
  trackedBits = 0;
  giftedSubs = 0;
  gifterCounts.clear();
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
  if (seenSubIds.has(event.id)) return;
  seenSubIds.add(event.id);
  trackedSubs += 1;
  if (event.isGift) {
    giftedSubs += 1;
    const key = `${event.gifterId ?? "anon"}:${event.gifterName ?? "Anonymous"}`;
    const current = gifterCounts.get(key) ?? {
      name: event.gifterName ?? "Anonymous",
      id: event.gifterId ?? null,
      gifts: 0,
    };
    current.gifts += 1;
    gifterCounts.set(key, current);
  }
  syncFruitberriesCheckpoint();
}

export function addBitEvent(event: {
  id: string;
  userId: string | null;
  userName: string | null;
  bits: number;
}) {
  if (seenBitIds.has(event.id)) return;
  seenBitIds.add(event.id);
  trackedBits += event.bits;
  syncFruitberriesCheckpoint();
}
