import {
  getStats, getConfig, setConfig, deleteConfigKeys, clearTrackedEvents, syncFruitberriesCheckpoint,
} from "./db.ts";
import {
  initTwitch, switchChannel, lookupChannel,
  connected, currentChannel,
  fetchStreamStatus, fetchStreamStatusForChannel, fetchChannelSubCount,
  getBroadcasterIdByToken,
  setStatsProvider,
} from "./twitch.ts";

const PORT          = parseInt(process.env.PORT || "3000");
const CLIENT_ID     = process.env.TWITCH_CLIENT_ID!;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET!;
const REDIRECT_URI  = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const DEFAULT_CHANNEL = "fruitberries";
const AUTH_KEYS = ["broadcaster_token", "broadcaster_id", "broadcaster_refresh", "baseline_subs"];
const AUTH_MODE_SELF = "self";
const AUTH_MODE_FRUIT = "fruitberries";
const TRACKING_ANON = "anonymous";
const TRACKING_LOGIN = "since_login";
const TRACKING_RESET = "since_reset";
const TRACKING_STREAM = "this_stream";

/* SSE */
type SSECtrl = ReadableStreamDefaultController<Uint8Array>;
const sseClients = new Set<SSECtrl>();

function broadcast(data: unknown) {
  const chunk = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
  for (const ctrl of sseClients) {
    try { ctrl.enqueue(chunk); }
    catch { sseClients.delete(ctrl); }
  }
}

/* Stream */
let wasLive = false;
let streamStatus = { live: false, title: "", viewers: 0, startedAt: 0 };
let streamPollTimer: ReturnType<typeof setInterval> | null = null;
let sawOfflineSinceActivation = false;

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

/* Server */
Bun.serve({
  port: PORT,
  idleTimeout: 0,

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(
        Bun.file(new URL("../public/index.html", import.meta.url).pathname),
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(
        Bun.file(new URL("../favicon.ico", import.meta.url).pathname),
        { headers: { "Content-Type": "image/x-icon" } }
      );
    }

    if (url.pathname === "/api/stats") {
      return Response.json(fullStats());
    }

    if (url.pathname === "/api/channel") {
      if (req.method === "GET") {
        const q = url.searchParams.get("q")?.trim().toLowerCase();
        if (!q) return Response.json({ error: "missing q" }, { status: 400 });
        if (q !== DEFAULT_CHANNEL) {
          return Response.json({ error: "log in as the broadcaster to track another channel" }, { status: 403 });
        }
        const info = await lookupChannel(q);
        if (!info) return Response.json({ error: "channel not found" }, { status: 404 });
        const stream = await fetchStreamStatusForChannel(info.login);
        return Response.json({ ...info, live: stream?.live ?? false });
      }

      if (req.method === "POST") {
        const body = await req.json().catch(() => ({})) as { login?: string };
        const login = body.login?.trim().toLowerCase();
        if (!login) return Response.json({ error: "missing login" }, { status: 400 });
        if (login !== DEFAULT_CHANNEL) {
          return Response.json({ error: "anonymous mode only tracks fruitberries" }, { status: 403 });
        }
        const info = await lookupChannel(DEFAULT_CHANNEL);
        if (!info) return Response.json({ error: "channel not found" }, { status: 404 });
        await activateChannel(info);
        return Response.json({ ok: true, ...info });
      }
    }

    if (url.pathname === "/api/start" && req.method === "POST") {
      if (!getConfig("broadcaster_token")) {
        return Response.json({ error: "broadcaster auth required" }, { status: 403 });
      }
      clearTrackedEvents();
      setConfig("subathon_start", String(Math.floor(Date.now() / 1000)));
      setConfig("baseline_subs", "0");
      setConfig("tracking_mode", TRACKING_RESET);
      syncFruitberriesCheckpoint();
      broadcast({ type: "reset", stats: fullStats() });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/events") {
      let ctrl: SSECtrl;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          sseClients.add(ctrl);
          ctrl.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ type: "init", stats: fullStats() })}\n\n`
          ));
        },
        cancel() { sseClients.delete(ctrl); },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      });
    }

    if (url.pathname === "/auth/twitch" || url.pathname === "/auth/fruitberries") {
      const authMode = url.pathname === "/auth/fruitberries" ? AUTH_MODE_FRUIT : AUTH_MODE_SELF;
      const params = new URLSearchParams({
        client_id:     CLIENT_ID,
        redirect_uri:  REDIRECT_URI,
        response_type: "code",
        scope:         "channel:read:subscriptions",
        state:         authMode,
      });
      return Response.redirect(`https://id.twitch.tv/oauth2/authorize?${params}`);
    }

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      const authMode = url.searchParams.get("state") || AUTH_MODE_SELF;
      if (!code) return new Response("Missing code", { status: 400 });

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

      await activateChannel(
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
      return Response.redirect("/");
    }

    if (url.pathname === "/auth/logout") {
      await activateDefaultChannel();
      return Response.redirect("/");
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`\n  subathon tracker  →  http://localhost:${PORT}\n`);

const hasFruitberriesCheckpoint =
  getConfig("channel_login") === DEFAULT_CHANNEL && !!getConfig("broadcaster_token");

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

initTwitch(broadcast)
  .then(() => hasFruitberriesCheckpoint ? resumeSavedFruitberriesSession() : activateDefaultChannel())
  .catch((err) => console.error("[twitch] init failed:", (err as Error).message));
