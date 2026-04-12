import {
  getStats, getConfig, setConfig, deleteConfigKeys, clearTrackedEvents, syncFruitberriesCheckpoint,
  saveSessionTracker, loadSessionTracker, listSessionTrackers,
  deleteSessionTracker as deleteSavedSessionTracker, deleteExpiredSessionTrackers,
  type PersistedSessionTracker,
} from "./db.ts";
import {
  initTwitch, switchChannel, lookupChannel,
  connected, currentChannel,
  fetchStreamStatus, fetchStreamStatusForChannel, fetchChannelSubCount,
  getBroadcasterIdByToken, refreshUserAccessToken,
  setStatsProvider,
  startPublicModFeed, stopPublicModFeed,
} from "./twitch.ts";

const PORT          = parseInt(process.env.PORT || "3000");
const CLIENT_ID     = process.env.TWITCH_CLIENT_ID!;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET!;
const REDIRECT_URI  = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const FRUIT_MOD_KEY = process.env.FRUIT_MOD_KEY || "";
const DEFAULT_CHANNEL = "fruitberries";
const AUTH_KEYS = ["broadcaster_token", "broadcaster_id", "broadcaster_refresh", "baseline_subs"];
const FRUIT_MOD_KEYS = ["fruit_mod_token", "fruit_mod_refresh", "fruit_mod_user_id", "fruit_mod_user_login"];
const AUTH_MODE_SELF = "self";
const AUTH_MODE_FRUIT = "fruitberries";
const AUTH_MODE_FRUIT_MOD = "fruitberries_mod";
const TRACKING_ANON = "anonymous";
const TRACKING_LOGIN = "since_login";
const TRACKING_RESET = "since_reset";
const TRACKING_STREAM = "this_stream";
const VIEW_PRIVATE = "private";
const VIEW_PUBLIC = "public";
const SESSION_TTL = 48 * 60 * 60;
const SESSION_COOKIE = "subathon_session";
const VIEW_COOKIE = "subathon_view";

/* SSE */
type SSECtrl = ReadableStreamDefaultController<Uint8Array>;
const sseClients = new Set<SSECtrl>();

type SessionTracker = {
  sessionId: string;
  channel: string;
  channelDisplay: string;
  channelAvatar: string;
  authToken: string | null;
  refreshToken: string | null;
  broadcasterId: string | null;
  persistent: boolean;
  connected: boolean;
  streamStatus: { live: boolean; title: string; viewers: number; startedAt: number };
  wasLive: boolean;
  sawOfflineSinceActivation: boolean;
  subathonStart: number;
  trackingMode: string;
  baselineSubs: number;
  trackedSubs: number;
  trackedBits: number;
  giftedSubs: number;
  gifters: Map<string, { name: string; id: string | null; gifts: number }>;
  seenSubIds: Set<string>;
  seenBitIds: Set<string>;
  clients: Set<SSECtrl>;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  destroyTimer: ReturnType<typeof setTimeout> | null;
  socketVersion: number;
  createdAt: number;
  expiresAt: number;
};

const sessionTrackers = new Map<string, SessionTracker>();

function broadcast(data: unknown) {
  const chunk = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
  for (const ctrl of sseClients) {
    try { ctrl.enqueue(chunk); }
    catch { sseClients.delete(ctrl); }
  }
}

function parseCookies(req: Request) {
  const raw = req.headers.get("cookie") || "";
  const out = new Map<string, string>();
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out.set(part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim()));
  }
  return out;
}

function sessionIdFromReq(req: Request) {
  return parseCookies(req).get(SESSION_COOKIE) || null;
}

function viewModeFromReq(req: Request) {
  return parseCookies(req).get(VIEW_COOKIE) === VIEW_PUBLIC ? VIEW_PUBLIC : VIEW_PRIVATE;
}

function ensureSessionId(req: Request) {
  return sessionIdFromReq(req) || crypto.randomUUID();
}

function sessionCookie(sessionId: string) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

function viewCookie(mode: string) {
  return `${VIEW_COOKIE}=${encodeURIComponent(mode)}; Path=/; SameSite=Lax; Max-Age=31536000`;
}

function withSessionState(res: Response, req: Request, sessionId: string, viewMode?: string) {
  const cookies: string[] = [];
  if (sessionIdFromReq(req) !== sessionId) cookies.push(sessionCookie(sessionId));
  if (viewMode && viewModeFromReq(req) !== viewMode) cookies.push(viewCookie(viewMode));
  if (!cookies.length) return res;
  const headers = new Headers(res.headers);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function encodeAuthState(mode: string, key = "") {
  return btoa(JSON.stringify({ mode, key }));
}

function decodeAuthState(raw: string | null) {
  if (!raw) return { mode: AUTH_MODE_SELF, key: "" };
  try {
    const decoded = JSON.parse(atob(raw)) as { mode?: string; key?: string };
    return { mode: decoded.mode || AUTH_MODE_SELF, key: decoded.key || "" };
  } catch {
    return { mode: raw, key: "" };
  }
}

/* Stream */
let wasLive = false;
let streamStatus = { live: false, title: "", viewers: 0, startedAt: 0 };
let streamPollTimer: ReturnType<typeof setInterval> | null = null;
let sawOfflineSinceActivation = false;
const IRC_WS = "wss://irc-ws.chat.twitch.tv:443";

function sessionStats(tracker: SessionTracker) {
  const gifters = [...tracker.gifters.values()]
    .sort((a, b) => b.gifts - a.gifts || a.name.localeCompare(b.name))
    .slice(0, 50)
    .map((gifter) => ({
      ...gifter,
      rank: gifter.gifts >= 100 ? "diamond"
        : gifter.gifts >= 50 ? "platinum"
        : gifter.gifts >= 25 ? "gold"
        : gifter.gifts >= 10 ? "silver"
        : gifter.gifts >= 5 ? "bronze"
        : "member",
    }));

  return {
    totalSubs: tracker.trackedSubs,
    totalBits: tracker.trackedBits,
    giftedSubs: tracker.giftedSubs,
    gifters,
    subathonStart: tracker.subathonStart,
    baselineSubs: tracker.baselineSubs,
    connected: tracker.connected,
    streamStart: tracker.streamStatus.startedAt,
    streamLive: tracker.streamStatus.live,
    streamViewers: tracker.streamStatus.viewers,
    hasBroadcasterAuth: !!tracker.authToken,
    channel: tracker.channel,
    channelDisplay: tracker.channelDisplay,
    channelAvatar: tracker.channelAvatar,
    defaultChannel: DEFAULT_CHANNEL,
    anonymousMode: false,
    temporaryMode: !tracker.persistent,
    privateTrackerPersistent: tracker.persistent,
    subsCardLabel: "subs gained",
    subsCardSub: tracker.trackingMode === TRACKING_STREAM
      ? "this stream"
      : tracker.trackingMode === TRACKING_RESET
        ? "tracked since reset"
        : !!tracker.authToken
          ? "tracked since login"
          : "tracked since search",
    hasPrivateTracker: true,
    viewingPrivateTracker: true,
  };
}

function sessionBroadcast(tracker: SessionTracker, data: unknown) {
  const chunk = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
  for (const ctrl of tracker.clients) {
    try { ctrl.enqueue(chunk); }
    catch { tracker.clients.delete(ctrl); }
  }
}

function uncappedSession(login: string) {
  return login.toLowerCase() === DEFAULT_CHANNEL;
}

function sessionExpired(tracker: SessionTracker) {
  return !!tracker.expiresAt && tracker.expiresAt <= Math.floor(Date.now() / 1000);
}

function serializeSessionTracker(tracker: SessionTracker): PersistedSessionTracker {
  return {
    sessionId: tracker.sessionId,
    channel: tracker.channel,
    channelDisplay: tracker.channelDisplay,
    channelAvatar: tracker.channelAvatar,
    authToken: tracker.authToken,
    refreshToken: tracker.refreshToken,
    broadcasterId: tracker.broadcasterId,
    streamStatus: tracker.streamStatus,
    wasLive: tracker.wasLive,
    sawOfflineSinceActivation: tracker.sawOfflineSinceActivation,
    subathonStart: tracker.subathonStart,
    trackingMode: tracker.trackingMode,
    baselineSubs: tracker.baselineSubs,
    trackedSubs: tracker.trackedSubs,
    trackedBits: tracker.trackedBits,
    giftedSubs: tracker.giftedSubs,
    gifters: [...tracker.gifters.entries()].map(([key, value]) => ({ key, ...value })),
    seenSubIds: [...tracker.seenSubIds],
    seenBitIds: [...tracker.seenBitIds],
    createdAt: tracker.createdAt,
    expiresAt: tracker.expiresAt,
  };
}

function persistSessionTrackerState(tracker: SessionTracker) {
  if (!tracker.persistent) return;
  saveSessionTracker(serializeSessionTracker(tracker));
}

function hydrateSessionTracker(state: PersistedSessionTracker): SessionTracker {
  return {
    sessionId: state.sessionId,
    channel: state.channel,
    channelDisplay: state.channelDisplay,
    channelAvatar: state.channelAvatar,
    authToken: state.authToken,
    refreshToken: state.refreshToken,
    broadcasterId: state.broadcasterId,
    persistent: true,
    connected: false,
    streamStatus: state.streamStatus,
    wasLive: state.wasLive,
    sawOfflineSinceActivation: state.sawOfflineSinceActivation,
    subathonStart: state.subathonStart,
    trackingMode: state.trackingMode,
    baselineSubs: state.baselineSubs,
    trackedSubs: state.trackedSubs,
    trackedBits: state.trackedBits,
    giftedSubs: state.giftedSubs,
    gifters: new Map(state.gifters.map((gifter) => [gifter.key, {
      name: gifter.name,
      id: gifter.id,
      gifts: gifter.gifts,
    }])),
    seenSubIds: new Set(state.seenSubIds),
    seenBitIds: new Set(state.seenBitIds),
    clients: new Set(),
    ws: null,
    reconnectTimer: null,
    pollTimer: null,
    destroyTimer: null,
    socketVersion: 0,
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
  };
}

function parseTags(raw: string) {
  const out: Record<string, string> = {};
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    out[eq === -1 ? pair : pair.slice(0, eq)] = eq === -1 ? "" : pair.slice(eq + 1);
  }
  return out;
}

function parseIRC(line: string) {
  let pos = 0;
  let tags: Record<string, string> = {};
  if (line[0] === "@") {
    const sp = line.indexOf(" ", 1);
    tags = parseTags(line.slice(1, sp));
    pos = sp + 1;
  }
  if (line[pos] === ":") pos = line.indexOf(" ", pos) + 1;
  const trailIdx = line.indexOf(" :", pos);
  const trailing = trailIdx !== -1 ? line.slice(trailIdx + 2) : "";
  const head = trailIdx !== -1 ? line.slice(pos, trailIdx) : line.slice(pos);
  const parts = head.trim().split(/\s+/);
  return { tags, command: parts[0] ?? "", params: parts.slice(1), trailing };
}

function applySessionSub(tracker: SessionTracker, event: {
  id: string;
  userId: string;
  userName: string;
  tier: string;
  isGift: boolean;
  gifterId?: string | null;
  gifterName?: string | null;
}) {
  if (tracker.seenSubIds.has(event.id)) return false;
  tracker.seenSubIds.add(event.id);
  tracker.trackedSubs += 1;
  if (event.isGift) {
    tracker.giftedSubs += 1;
    const key = `${event.gifterId ?? "anon"}:${event.gifterName ?? "Anonymous"}`;
    const current = tracker.gifters.get(key) ?? {
      name: event.gifterName ?? "Anonymous",
      id: event.gifterId ?? null,
      gifts: 0,
    };
    current.gifts += 1;
    tracker.gifters.set(key, current);
  }
  persistSessionTrackerState(tracker);
  return true;
}

function applySessionBits(tracker: SessionTracker, id: string, bits: number) {
  if (tracker.seenBitIds.has(id)) return false;
  tracker.seenBitIds.add(id);
  tracker.trackedBits += bits;
  persistSessionTrackerState(tracker);
  return true;
}

async function seedSessionBaseline(tracker: SessionTracker) {
  if (!tracker.authToken || !tracker.broadcasterId) return;
  const count = await fetchChannelSubCount(tracker.authToken, tracker.broadcasterId);
  if (count == null) return;
  tracker.baselineSubs = count;
  persistSessionTrackerState(tracker);
}

async function pollSessionStream(tracker: SessionTracker) {
  const status = await fetchStreamStatusForChannel(tracker.channel);
  if (!status || sessionTrackers.get(tracker.sessionId) !== tracker) return;
  tracker.streamStatus = status;
  if (!status.live) tracker.sawOfflineSinceActivation = true;
  if (status.live && !tracker.wasLive) {
    if (tracker.sawOfflineSinceActivation) {
      tracker.subathonStart = status.startedAt || Math.floor(Date.now() / 1000);
      tracker.trackingMode = TRACKING_STREAM;
    }
    await seedSessionBaseline(tracker);
    sessionBroadcast(tracker, { type: "stream_live", stream: status, stats: sessionStats(tracker) });
  } else {
    sessionBroadcast(tracker, { type: "stream_update", stream: status });
  }
  tracker.wasLive = status.live;
  persistSessionTrackerState(tracker);
}

async function startSessionPoll(tracker: SessionTracker) {
  if (tracker.pollTimer) clearInterval(tracker.pollTimer);
  await pollSessionStream(tracker);
  tracker.pollTimer = setInterval(() => {
    void pollSessionStream(tracker);
  }, 60_000);
}

function connectSessionIRC(tracker: SessionTracker) {
  const nick = `justinfan${Math.floor(Math.random() * 80000) + 10000}`;
  const socket = new WebSocket(IRC_WS);
  tracker.ws = socket;
  const version = ++tracker.socketVersion;
  let capAcked = false;

  socket.onopen = () => {
    if (tracker.ws !== socket || tracker.socketVersion !== version) return;
    socket.send("PASS SCHMOOPIIE");
    socket.send(`NICK ${nick}`);
    socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
  };

  socket.onmessage = (ev) => {
    if (tracker.ws !== socket || tracker.socketVersion !== version) return;
    for (const line of (ev.data as string).split("\r\n").filter(Boolean)) {
      const msg = parseIRC(line);
      switch (msg.command) {
        case "PING":
          socket.send(`PONG :${msg.trailing}`);
          break;
        case "CAP":
          if (!capAcked && msg.params[1] === "ACK") {
            capAcked = true;
            socket.send(`JOIN #${tracker.channel}`);
          }
          break;
        case "001":
          tracker.connected = true;
          sessionBroadcast(tracker, { type: "connected", stats: sessionStats(tracker) });
          break;
        case "USERNOTICE": {
          const tags = msg.tags;
          const msgId = tags["msg-id"] ?? "";
          const name = tags["display-name"] || tags["login"] || "unknown";
          const userId = tags["user-id"] || name;
          const tier = tags["msg-param-sub-plan"] || "1000";
          if (msgId === "sub" || msgId === "resub") {
            if (!applySessionSub(tracker, {
              id: `${msgId}_${tags["id"] || Date.now()}`,
              userId, userName: name, tier, isGift: false,
            })) break;
            sessionBroadcast(tracker, { type: msgId, userName: name, stats: sessionStats(tracker) });
            break;
          }
          if (msgId === "subgift" || msgId === "anonsubgift") {
            const recipient = tags["msg-param-recipient-display-name"] || "unknown";
            const recipientId = tags["msg-param-recipient-id"] || recipient;
            const isAnon = msgId === "anonsubgift";
            const isBatch = !!tags["msg-param-origin-id"];
            if (!applySessionSub(tracker, {
              id: `${msgId}_${tags["id"] || Date.now()}`,
              userId: recipientId,
              userName: recipient,
              tier,
              isGift: true,
              gifterId: isAnon ? null : userId,
              gifterName: isAnon ? null : name,
            })) break;
            sessionBroadcast(tracker, {
              type: isBatch ? "stats_update" : "gift",
              gifterName: isAnon ? "Anonymous" : name,
              total: 1,
              stats: sessionStats(tracker),
            });
            break;
          }
          if (msgId === "submysterygift" || msgId === "anonsubmysterygift") {
            const count = parseInt(tags["msg-param-mass-gift-count"] || "1", 10);
            sessionBroadcast(tracker, {
              type: "gift",
              gifterName: msgId === "anonsubmysterygift" ? "Anonymous" : name,
              total: count,
              stats: sessionStats(tracker),
            });
          }
          break;
        }
        case "PRIVMSG": {
          const bits = parseInt(msg.tags["bits"] || "0", 10);
          if (!bits) break;
          if (!applySessionBits(tracker, `cheer_${msg.tags["id"] || Date.now()}`, bits)) break;
          sessionBroadcast(tracker, { type: "bits", bits, stats: sessionStats(tracker) });
          break;
        }
      }
    }
  };

  socket.onclose = () => {
    if (tracker.ws !== socket || tracker.socketVersion !== version) return;
    tracker.connected = false;
    tracker.ws = null;
    sessionBroadcast(tracker, { type: "disconnected", stats: sessionStats(tracker) });
    if (sessionTrackers.get(tracker.sessionId) !== tracker) return;
    tracker.reconnectTimer = setTimeout(() => connectSessionIRC(tracker), 5000);
  };
}

function cancelSessionDestroy(tracker: SessionTracker) {
  if (!tracker.destroyTimer) return;
  clearTimeout(tracker.destroyTimer);
  tracker.destroyTimer = null;
}

function scheduleSessionDestroy(tracker: SessionTracker) {
  if (tracker.persistent || tracker.clients.size) return;
  cancelSessionDestroy(tracker);
  tracker.destroyTimer = setTimeout(() => {
    if (!tracker.clients.size) destroySessionTracker(tracker.sessionId, true);
  }, 30_000);
}

async function createSessionTracker(
  sessionId: string,
  info: { login: string; displayName: string; avatarUrl: string },
  auth?: { token: string; refreshToken?: string; broadcasterId: string }
) {
  destroySessionTracker(sessionId, true);
  const now = Math.floor(Date.now() / 1000);
  const persistent = !!auth;
  const tracker: SessionTracker = {
    sessionId,
    channel: info.login,
    channelDisplay: info.displayName,
    channelAvatar: info.avatarUrl,
    authToken: auth?.token || null,
    refreshToken: auth?.refreshToken || null,
    broadcasterId: auth?.broadcasterId || null,
    persistent,
    connected: false,
    streamStatus: { live: false, title: "", viewers: 0, startedAt: 0 },
    wasLive: false,
    sawOfflineSinceActivation: false,
    subathonStart: Math.floor(Date.now() / 1000),
    trackingMode: TRACKING_LOGIN,
    baselineSubs: 0,
    trackedSubs: 0,
    trackedBits: 0,
    giftedSubs: 0,
    gifters: new Map(),
    seenSubIds: new Set(),
    seenBitIds: new Set(),
    clients: new Set(),
    ws: null,
    reconnectTimer: null,
    pollTimer: null,
    destroyTimer: null,
    socketVersion: 0,
    createdAt: now,
    expiresAt: persistent ? (uncappedSession(info.login) ? 0 : now + SESSION_TTL) : 0,
  };
  sessionTrackers.set(sessionId, tracker);
  persistSessionTrackerState(tracker);
  connectSessionIRC(tracker);
  await startSessionPoll(tracker);
  persistSessionTrackerState(tracker);
  sessionBroadcast(tracker, { type: "channel_set", stats: sessionStats(tracker) });
  return tracker;
}

function destroySessionTracker(sessionId: string, removeSaved = true) {
  const tracker = sessionTrackers.get(sessionId);
  if (tracker) {
    cancelSessionDestroy(tracker);
    if (tracker.reconnectTimer) clearTimeout(tracker.reconnectTimer);
    if (tracker.pollTimer) clearInterval(tracker.pollTimer);
    tracker.ws?.close();
    tracker.ws = null;
    sessionTrackers.delete(sessionId);
  }
  if (removeSaved && (!tracker || tracker.persistent)) deleteSavedSessionTracker(sessionId);
}

async function restoreSessionTracker(sessionId: string) {
  const existing = sessionTrackers.get(sessionId);
  if (existing) {
    if (!sessionExpired(existing)) return existing;
    destroySessionTracker(sessionId, true);
    return null;
  }
  const saved = loadSessionTracker(sessionId);
  if (!saved) return null;
  if (saved.expiresAt && saved.expiresAt <= Math.floor(Date.now() / 1000)) {
    deleteSavedSessionTracker(sessionId);
    return null;
  }
  const tracker = hydrateSessionTracker(saved);
  sessionTrackers.set(sessionId, tracker);
  connectSessionIRC(tracker);
  await startSessionPoll(tracker);
  persistSessionTrackerState(tracker);
  return tracker;
}

async function restoreSavedSessionTrackers() {
  const now = Math.floor(Date.now() / 1000);
  deleteExpiredSessionTrackers(now);
  for (const saved of listSessionTrackers()) {
    if (saved.expiresAt && saved.expiresAt <= now) continue;
    const tracker = hydrateSessionTracker(saved);
    sessionTrackers.set(tracker.sessionId, tracker);
    connectSessionIRC(tracker);
    await startSessionPoll(tracker);
    persistSessionTrackerState(tracker);
  }
}

function pruneExpiredSessionTrackers() {
  const now = Math.floor(Date.now() / 1000);
  for (const [sessionId, tracker] of sessionTrackers) {
    if (!tracker.expiresAt || tracker.expiresAt > now) continue;
    destroySessionTracker(sessionId, true);
  }
  deleteExpiredSessionTrackers(now);
}

async function seedSubBaseline() {
  const token = getConfig("broadcaster_token");
  const bid   = getConfig("broadcaster_id");
  if (!token || !bid) return;
  const count = await fetchChannelSubCount(token, bid);
  if (count == null) { console.log("[broadcaster] token expired"); return; }
  setConfig("baseline_subs", String(count));
  console.log(`[broadcaster] seeded baseline: ${count} subs`);
}

async function pollStream() {
  const trackedChannel = getConfig("channel_login");
  const polledChannel = currentChannel;
  const status = await fetchStreamStatus();
  if (!status) return;
  if (!trackedChannel || trackedChannel !== getConfig("channel_login")) return;
  if (polledChannel !== currentChannel || polledChannel !== trackedChannel) return;
  streamStatus = status;
  if (!status.live) sawOfflineSinceActivation = true;
  if (status.live && !wasLive) {
    if (getConfig("broadcaster_token") && sawOfflineSinceActivation) {
      setConfig("subathon_start", String(status.startedAt || Math.floor(Date.now() / 1000)));
      setConfig("tracking_mode", TRACKING_STREAM);
      syncFruitberriesCheckpoint();
    }
    await seedSubBaseline();
    broadcast({ type: "stream_live", stream: status, stats: fullStats() });
  } else {
    broadcast({ type: "stream_update", stream: status });
  }
  wasLive = status.live;
}

async function startStreamPoll() {
  if (streamPollTimer) clearInterval(streamPollTimer);
  await pollStream();
  streamPollTimer = setInterval(pollStream, 60_000);
}

/* Stats */
function fullStats() {
  return buildStats(connected);
}

async function sessionTrackerForRequest(req: Request) {
  const sessionId = sessionIdFromReq(req);
  if (!sessionId) return null;
  if (viewModeFromReq(req) !== VIEW_PRIVATE) return null;
  return restoreSessionTracker(sessionId);
}

async function savedTrackerForRequest(req: Request) {
  const sessionId = sessionIdFromReq(req);
  if (!sessionId) return null;
  return sessionTrackers.get(sessionId) || restoreSessionTracker(sessionId);
}

async function statsForRequest(req: Request) {
  const viewMode = viewModeFromReq(req);
  const tracker = await sessionTrackerForRequest(req);
  const savedTracker = tracker ?? (viewMode === VIEW_PRIVATE ? null : await savedTrackerForRequest(req));
  const hasPrivateTracker = !!savedTracker;
  const viewingPrivateTracker = !!tracker;
  const privateTrackerPersistent = !!savedTracker?.persistent;
  if (tracker) {
    return {
      ...sessionStats(tracker),
      hasPrivateTracker,
      viewingPrivateTracker,
      privateTrackerPersistent,
    };
  }
  return {
    ...fullStats(),
    hasPrivateTracker,
    viewingPrivateTracker,
    privateTrackerPersistent,
  };
}

function buildStats(connectedState: boolean) {
  const baseStats = getStats(connectedState);
  const channel = getConfig("channel_login");
  const hasBroadcasterAuth = !!getConfig("broadcaster_token");
  const trackingMode = getConfig("tracking_mode") || TRACKING_ANON;
  const subsCardSub = trackingMode === TRACKING_STREAM
    ? "this stream"
    : trackingMode === TRACKING_RESET
      ? "tracked since reset"
      : trackingMode === TRACKING_LOGIN
        ? "tracked since login"
        : "tracked since startup";
  return {
    ...baseStats,
    streamStart:    streamStatus.startedAt,
    streamLive:     streamStatus.live,
    streamViewers:  streamStatus.viewers,
    hasBroadcasterAuth,
    channel,
    channelDisplay: getConfig("channel_display_name"),
    channelAvatar:  getConfig("channel_avatar"),
    defaultChannel: DEFAULT_CHANNEL,
    anonymousMode: !hasBroadcasterAuth && channel === DEFAULT_CHANNEL,
    temporaryMode: false,
    subsCardLabel: "subs gained",
    subsCardSub,
  };
}

setStatsProvider((connectedState) => buildStats(connectedState));

function resetTrackerState(clearAuth = true) {
  clearTrackedEvents();
  if (clearAuth) deleteConfigKeys(AUTH_KEYS);
  setConfig("baseline_subs", "0");
  setConfig("subathon_start", String(Math.floor(Date.now() / 1000)));
  streamStatus = { live: false, title: "", viewers: 0, startedAt: 0 };
  wasLive = false;
  sawOfflineSinceActivation = false;
  syncFruitberriesCheckpoint();
}

function setTrackedChannel(info: { login: string; displayName: string; avatarUrl: string }) {
  setConfig("channel_login", info.login);
  setConfig("channel_display_name", info.displayName);
  setConfig("channel_avatar", info.avatarUrl);
}

async function activateChannel(
  info: { login: string; displayName: string; avatarUrl: string },
  auth?: { token: string; refreshToken?: string; broadcasterId: string }
) {
  resetTrackerState(!auth);
  setTrackedChannel(info);
  setConfig("tracking_mode", auth ? TRACKING_LOGIN : TRACKING_ANON);
  if (auth) {
    setConfig("broadcaster_token", auth.token);
    setConfig("broadcaster_id", auth.broadcasterId);
    if (auth.refreshToken) setConfig("broadcaster_refresh", auth.refreshToken);
  }
  await switchChannel(info.login, broadcast);
  await startStreamPoll();
  syncFruitberriesCheckpoint();
  broadcast({ type: "channel_set", stats: fullStats() });
}

async function activateDefaultChannel() {
  const info = await lookupChannel(DEFAULT_CHANNEL) ?? {
    id: "",
    login: DEFAULT_CHANNEL,
    displayName: DEFAULT_CHANNEL,
    avatarUrl: "",
  };
  await activateChannel(info);
}

async function enableFruitberriesModFeed(auth: {
  token: string;
  refreshToken?: string;
  userId: string;
  userLogin: string;
}) {
  const channel = await lookupChannel(DEFAULT_CHANNEL);
  if (!channel?.id) throw new Error("Could not resolve fruitberries channel");
  setConfig("fruit_mod_token", auth.token);
  setConfig("fruit_mod_user_id", auth.userId);
  setConfig("fruit_mod_user_login", auth.userLogin);
  if (auth.refreshToken) setConfig("fruit_mod_refresh", auth.refreshToken);
  await startPublicModFeed({
    token: auth.token,
    userId: auth.userId,
    broadcasterId: channel.id,
  }, broadcast);
}

async function resumeFruitberriesModFeed() {
  const savedUserId = getConfig("fruit_mod_user_id");
  const savedUserLogin = getConfig("fruit_mod_user_login");
  let token = getConfig("fruit_mod_token");
  let refresh = getConfig("fruit_mod_refresh");
  if (!savedUserId || !savedUserLogin || !token) return;

  if (refresh) {
    const refreshed = await refreshUserAccessToken(refresh);
    if (refreshed) {
      token = refreshed.accessToken;
      refresh = refreshed.refreshToken;
      setConfig("fruit_mod_token", token);
      setConfig("fruit_mod_refresh", refresh);
    }
  }

  try {
    await enableFruitberriesModFeed({
      token,
      refreshToken: refresh || undefined,
      userId: savedUserId,
      userLogin: savedUserLogin,
    });
    console.log(`[eventsub] public fruitberries mod feed ready via ${savedUserLogin}`);
  } catch (err) {
    console.error("[eventsub] public fruitberries mod feed failed:", (err as Error).message);
  }
}

/* Server */
Bun.serve({
  port: PORT,
  idleTimeout: 0,

  async fetch(req) {
    const url = new URL(req.url);
    const sessionId = ensureSessionId(req);
    const privateTracker = await sessionTrackerForRequest(req);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return withSessionState(new Response(
        Bun.file(new URL("../public/index.html", import.meta.url).pathname),
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      ), req, sessionId);
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(
        Bun.file(new URL("../favicon.ico", import.meta.url).pathname),
        { headers: { "Content-Type": "image/x-icon" } }
      );
    }

    if (url.pathname === "/api/stats") {
      return withSessionState(Response.json(await statsForRequest(req)), req, sessionId);
    }

    if (url.pathname === "/api/channel") {
      if (req.method === "GET") {
        const q = url.searchParams.get("q")?.trim().toLowerCase();
        if (!q) return Response.json({ error: "missing q" }, { status: 400 });
        const info = await lookupChannel(q);
        if (!info) return Response.json({ error: "channel not found" }, { status: 404 });
        const stream = await fetchStreamStatusForChannel(info.login);
        return Response.json({ ...info, live: stream?.live ?? false });
      }

      if (req.method === "POST") {
        const body = await req.json().catch(() => ({})) as { login?: string };
        const login = body.login?.trim().toLowerCase();
        if (!login) return Response.json({ error: "missing login" }, { status: 400 });
        const info = await lookupChannel(login);
        if (!info) return Response.json({ error: "channel not found" }, { status: 404 });
        if (info.login.toLowerCase() === DEFAULT_CHANNEL) {
          return withSessionState(Response.json({ ok: true, public: true, ...info }), req, sessionId, VIEW_PUBLIC);
        }
        await createSessionTracker(sessionId, info);
        return withSessionState(Response.json({ ok: true, public: false, ...sessionStats(sessionTrackers.get(sessionId)!) }), req, sessionId, VIEW_PRIVATE);
      }
    }

    if (url.pathname === "/api/start" && req.method === "POST") {
      if (privateTracker) {
        privateTracker.trackedSubs = 0;
        privateTracker.trackedBits = 0;
        privateTracker.giftedSubs = 0;
        privateTracker.gifters.clear();
        privateTracker.seenSubIds.clear();
        privateTracker.seenBitIds.clear();
        privateTracker.subathonStart = Math.floor(Date.now() / 1000);
        privateTracker.baselineSubs = 0;
        privateTracker.trackingMode = TRACKING_RESET;
        persistSessionTrackerState(privateTracker);
        sessionBroadcast(privateTracker, { type: "reset", stats: sessionStats(privateTracker) });
        return withSessionState(Response.json({ ok: true }), req, sessionId, VIEW_PRIVATE);
      }
      if (!getConfig("broadcaster_token")) {
        return Response.json({ error: "broadcaster auth required" }, { status: 403 });
      }
      clearTrackedEvents();
      setConfig("subathon_start", String(Math.floor(Date.now() / 1000)));
      setConfig("baseline_subs", "0");
      setConfig("tracking_mode", TRACKING_RESET);
      syncFruitberriesCheckpoint();
      broadcast({ type: "reset", stats: fullStats() });
      return withSessionState(Response.json({ ok: true }), req, sessionId);
    }

    if (url.pathname === "/api/events") {
      let ctrl: SSECtrl;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          if (privateTracker) {
            cancelSessionDestroy(privateTracker);
            privateTracker.clients.add(ctrl);
          } else sseClients.add(ctrl);
          ctrl.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ type: "init", stats: privateTracker ? sessionStats(privateTracker) : fullStats() })}\n\n`
          ));
        },
        cancel() {
          if (privateTracker) {
            privateTracker.clients.delete(ctrl);
            scheduleSessionDestroy(privateTracker);
          } else sseClients.delete(ctrl);
        },
      });
      return withSessionState(new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      }), req, sessionId);
    }

    if (url.pathname === "/api/view/public" && req.method === "POST") {
      return withSessionState(Response.json({ ok: true }), req, sessionId, VIEW_PUBLIC);
    }

    if (url.pathname === "/api/view/private" && req.method === "POST") {
      const tracker = await restoreSessionTracker(sessionId);
      if (!tracker) return withSessionState(Response.json({ error: "no private tracker" }, { status: 404 }), req, sessionId, VIEW_PUBLIC);
      return withSessionState(Response.json({ ok: true }), req, sessionId, VIEW_PRIVATE);
    }

    if (url.pathname === "/auth/twitch" || url.pathname === "/auth/fruitberries" || url.pathname === "/auth/fruitberries-mod") {
      if (url.pathname === "/auth/twitch") {
        const savedTracker = await restoreSessionTracker(sessionId);
        if (savedTracker?.persistent) return withSessionState(Response.redirect("/"), req, sessionId, VIEW_PRIVATE);
      }
      if (url.pathname === "/auth/fruitberries-mod") {
        if (!FRUIT_MOD_KEY || url.searchParams.get("key") !== FRUIT_MOD_KEY) {
          return new Response("Not Found", { status: 404 });
        }
      }
      const authMode = url.pathname === "/auth/fruitberries"
        ? AUTH_MODE_FRUIT
        : url.pathname === "/auth/fruitberries-mod"
          ? AUTH_MODE_FRUIT_MOD
          : AUTH_MODE_SELF;
      const scope = authMode === AUTH_MODE_FRUIT_MOD ? "user:read:chat" : "channel:read:subscriptions";
      const params = new URLSearchParams({
        client_id:     CLIENT_ID,
        redirect_uri:  REDIRECT_URI,
        response_type: "code",
        scope,
        state:         encodeAuthState(authMode, authMode === AUTH_MODE_FRUIT_MOD ? FRUIT_MOD_KEY : ""),
      });
      return withSessionState(Response.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`), req, sessionId);
    }

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      const state = decodeAuthState(url.searchParams.get("state"));
      const authMode = state.mode;
      const authError = url.searchParams.get("error");
      if (authError || !code) return withSessionState(Response.redirect("/"), req, sessionId, VIEW_PUBLIC);

      const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
          code, grant_type: "authorization_code", redirect_uri: REDIRECT_URI,
        }),
      });
      const td = (await tokenRes.json()) as { access_token?: string; refresh_token?: string };
      if (!td.access_token) return new Response("OAuth failed", { status: 500 });

      const bid = await getBroadcasterIdByToken(td.access_token);
      if (!bid) return new Response("Could not fetch user", { status: 500 });

      const userRes = await fetch("https://api.twitch.tv/helix/users", {
        headers: { "Client-ID": CLIENT_ID, Authorization: `Bearer ${td.access_token}` },
      });
      const userData = (await userRes.json()) as {
        data?: { login: string; display_name: string; profile_image_url: string }[];
      };
      const authedUser = userData.data?.[0];
      if (!authedUser?.login) return new Response("Could not fetch user", { status: 500 });
      const authedLogin = authedUser.login.toLowerCase();

      if (authMode === AUTH_MODE_FRUIT_MOD) {
        if (!FRUIT_MOD_KEY || state.key !== FRUIT_MOD_KEY) {
          return new Response("Not Found", { status: 404 });
        }
        try {
          await enableFruitberriesModFeed({
            token: td.access_token,
            refreshToken: td.refresh_token,
            userId: bid,
            userLogin: authedLogin,
          });
          console.log(`[eventsub] public fruitberries mod feed authenticated as ${authedLogin}`);
          return withSessionState(Response.redirect("/"), req, sessionId, VIEW_PUBLIC);
        } catch (err) {
          stopPublicModFeed();
          deleteConfigKeys(FRUIT_MOD_KEYS);
          return new Response(
            `<html><body style="font-family:monospace;background:#0a0a0f;color:#f8f8f2;padding:2rem">
              <p style="color:#ff5555;margin-bottom:1rem">Fruitberries mod feed setup failed.</p>
              <p style="color:#6272a4;margin-bottom:1rem">${String((err as Error).message || err)}</p>
              <p><a href="/" style="color:#bd93f9">← back</a></p>
            </body></html>`,
            { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }
      }

      if (authMode === AUTH_MODE_FRUIT && authedLogin !== DEFAULT_CHANNEL) {
        return new Response(
          `<html><body style="font-family:monospace;background:#0a0a0f;color:#f8f8f2;padding:2rem">
            <p style="color:#ffb86c;margin-bottom:1rem">Only fruitberries can see the real fruitberries content.</p>
            <p style="color:#6272a4;margin-bottom:1rem">You logged in as <strong style="color:#f8f8f2">${authedLogin}</strong>.</p>
            <p><a href="/" style="color:#bd93f9">← back</a></p>
          </body></html>`,
          { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }

      await createSessionTracker(
        sessionId,
        {
          login: authMode === AUTH_MODE_FRUIT ? DEFAULT_CHANNEL : authedLogin,
          displayName: authedUser.display_name,
          avatarUrl: authedUser.profile_image_url,
        },
        {
          token: td.access_token,
          refreshToken: td.refresh_token,
          broadcasterId: bid,
        }
      );

      console.log(`[broadcaster] authenticated as ${authedLogin}`);
      return withSessionState(Response.redirect("/"), req, sessionId, VIEW_PRIVATE);
    }

    if (url.pathname === "/auth/logout") {
      destroySessionTracker(sessionId, true);
      return withSessionState(Response.redirect("/"), req, sessionId, VIEW_PUBLIC);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`\n  subathon tracker  →  http://localhost:${PORT}\n`);

const hasFruitberriesCheckpoint =
  getConfig("channel_login") === DEFAULT_CHANNEL && !!getConfig("subathon_start");

if (!getConfig("channel_login")) {
  setConfig("channel_login", DEFAULT_CHANNEL);
  setConfig("channel_display_name", DEFAULT_CHANNEL);
  setConfig("channel_avatar", "");
  setConfig("baseline_subs", "0");
  setConfig("subathon_start", String(Math.floor(Date.now() / 1000)));
  setConfig("tracking_mode", TRACKING_ANON);
}

async function resumeSavedFruitberriesSession() {
  const login = getConfig("channel_login");
  if (!login) return activateDefaultChannel();
  await switchChannel(login, broadcast);
  await startStreamPoll();
  syncFruitberriesCheckpoint();
  broadcast({ type: "channel_set", stats: fullStats() });
}

setInterval(pruneExpiredSessionTrackers, 5 * 60_000);

initTwitch(broadcast)
  .then(async () => {
    if (hasFruitberriesCheckpoint) await resumeSavedFruitberriesSession();
    else await activateDefaultChannel();
    await resumeFruitberriesModFeed();
    await restoreSavedSessionTrackers();
  })
  .catch((err) => console.error("[twitch] init failed:", (err as Error).message));
