import { addSubEvent, addBitEvent, addGiftBatchEvent, getStats } from "./db.ts";

const IRC_WS        = "wss://irc-ws.chat.twitch.tv:443";
const EVENTSUB_WS   = "wss://eventsub.wss.twitch.tv/ws";
const CLIENT_ID     = process.env.TWITCH_CLIENT_ID!;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET!;

type BroadcastFn = (data: unknown) => void;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
export let connected = false;
export let currentChannel = "";
let socketVersion = 0;
let publicSubSource: "irc" | "eventsub" = "irc";
let eventsubWs: WebSocket | null = null;
let eventsubReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let eventsubSessionId = "";
let eventsubSocketVersion = 0;
let eventsubAuth: {
  token: string;
  userId: string;
  broadcasterId: string;
} | null = null;

let appToken: string | null = null;
let savedBroadcast: BroadcastFn | null = null;
let statsProvider: ((connected: boolean) => unknown) | null = null;

function currentStatsSnapshot(isConnected: boolean) {
  return statsProvider ? statsProvider(isConnected) : getStats(isConnected);
}

/* Tokens */
async function getAppToken(): Promise<string> {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const data = (await res.json()) as { access_token?: string; message?: string };
  if (!data.access_token) throw new Error(`Failed to get app token: ${data.message}`);
  return data.access_token;
}

/* Helix */
export async function fetchStreamStatusForChannel(login: string): Promise<{ live: boolean; title: string; viewers: number; startedAt: number } | null> {
  if (!appToken || !login) return null;
  try {
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${login}`, {
      headers: { "Client-ID": CLIENT_ID, Authorization: `Bearer ${appToken}` },
    });
    const data = (await res.json()) as { data?: { title: string; viewer_count: number; started_at: string }[] };
    const stream = data.data?.[0];
    return stream
      ? { live: true, title: stream.title, viewers: stream.viewer_count, startedAt: Math.floor(new Date(stream.started_at).getTime() / 1000) }
      : { live: false, title: "", viewers: 0, startedAt: 0 };
  } catch {
    return null;
  }
}

export async function fetchStreamStatus(): Promise<{ live: boolean; title: string; viewers: number; startedAt: number } | null> {
  if (!currentChannel) return null;
  return fetchStreamStatusForChannel(currentChannel);
}

export async function fetchChannelSubCount(broadcasterToken: string, broadcasterId: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${broadcasterId}&first=1`,
      { headers: { "Client-ID": CLIENT_ID, Authorization: `Bearer ${broadcasterToken}` } }
    );
    if (res.status === 401) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as { total?: number };
    return data.total ?? null;
  } catch {
    return null;
  }
}

export async function getBroadcasterIdByToken(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.twitch.tv/helix/users", {
      headers: { "Client-ID": CLIENT_ID, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { id: string }[] };
    return data.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function refreshUserAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (!data.access_token || !data.refresh_token) return null;
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  } catch {
    return null;
  }
}

/* IRC */
function parseTags(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    out[eq === -1 ? pair : pair.slice(0, eq)] = eq === -1 ? "" : pair.slice(eq + 1);
  }
  return out;
}

interface IRCMsg {
  tags:     Record<string, string>;
  command:  string;
  params:   string[];
  trailing: string;
}

function parseIRC(line: string): IRCMsg {
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
  const head     = trailIdx !== -1 ? line.slice(pos, trailIdx) : line.slice(pos);
  const parts    = head.trim().split(/\s+/);

  return { tags, command: parts[0] ?? "", params: parts.slice(1), trailing };
}

function onUserNotice(tags: Record<string, string>, broadcast: BroadcastFn) {
  if (publicSubSource === "eventsub") return;
  const msgId  = tags["msg-id"] ?? "";
  const name   = tags["display-name"] || tags["login"] || "unknown";
  const userId = tags["user-id"] || name;
  const tier   = tags["msg-param-sub-plan"] || "1000";

  switch (msgId) {
    case "sub": {
      addSubEvent({
        id: `sub_${tags["id"] || Date.now()}`,
        userId, userName: name, tier, isGift: false,
      });
      broadcast({ type: "sub", userName: name, stats: currentStatsSnapshot(connected) });
      break;
    }

    case "resub": {
      addSubEvent({
        id: `resub_${tags["id"] || Date.now()}`,
        userId, userName: name, tier, isGift: false,
      });
      broadcast({ type: "resub", userName: name, stats: currentStatsSnapshot(connected) });
      break;
    }

    case "subgift": {
      const recipient   = tags["msg-param-recipient-display-name"] || "unknown";
      const recipientId = tags["msg-param-recipient-id"] || recipient;
      const isBatch = !!tags["msg-param-origin-id"];

      addSubEvent({
        id: `gift_${tags["id"] || Date.now()}`,
        userId: recipientId, userName: recipient, tier, isGift: true,
        gifterId: userId, gifterName: name,
      });

      if (!isBatch) {
        broadcast({ type: "gift", gifterName: name, total: 1, stats: currentStatsSnapshot(connected) });
      } else {
        broadcast({ type: "stats_update", stats: currentStatsSnapshot(connected) });
      }
      break;
    }

    case "submysterygift": {
      const count = parseInt(tags["msg-param-mass-gift-count"] || "1");
      broadcast({ type: "gift", gifterName: name, total: count, stats: currentStatsSnapshot(connected) });
      break;
    }

    case "anonsubgift": {
      const recipient   = tags["msg-param-recipient-display-name"] || "unknown";
      const recipientId = tags["msg-param-recipient-id"] || recipient;
      const isBatch     = !!tags["msg-param-origin-id"];
      addSubEvent({
        id: `gift_anon_${tags["id"] || Date.now()}`,
        userId: recipientId, userName: recipient, tier, isGift: true,
        gifterId: null, gifterName: null,
      });
      if (!isBatch) {
        broadcast({ type: "gift", gifterName: "Anonymous", total: 1, stats: currentStatsSnapshot(connected) });
      } else {
        broadcast({ type: "stats_update", stats: currentStatsSnapshot(connected) });
      }
      break;
    }

    case "anonsubmysterygift": {
      const count = parseInt(tags["msg-param-mass-gift-count"] || "1");
      broadcast({ type: "gift", gifterName: "Anonymous", total: count, stats: currentStatsSnapshot(connected) });
      break;
    }
  }
}

type ChatNotificationEvent = {
  chatter_user_id?: string;
  chatter_user_name?: string;
  chatter_user_login?: string;
  chatter_is_anonymous?: boolean;
  system_message?: string;
  message_id?: string;
  notice_type?: string;
  sub?: { sub_plan?: string } | null;
  resub?: {
    sub_plan?: string;
    is_gift?: boolean;
    gifter_is_anonymous?: boolean | null;
    gifter_user_id?: string | null;
    gifter_user_name?: string | null;
  } | null;
  sub_gift?: {
    sub_plan?: string;
    recipient_user_id?: string | null;
    recipient_user_name?: string | null;
    recipient_user_login?: string | null;
    community_gift_id?: string | null;
  } | null;
  community_sub_gift?: {
    sub_plan?: string;
    total?: number;
    id?: string | null;
  } | null;
  shared_chat_sub?: { sub_plan?: string } | null;
  shared_chat_resub?: {
    sub_plan?: string;
    is_gift?: boolean;
    gifter_is_anonymous?: boolean | null;
    gifter_user_id?: string | null;
    gifter_user_name?: string | null;
  } | null;
  shared_chat_sub_gift?: {
    sub_plan?: string;
    recipient_user_id?: string | null;
    recipient_user_name?: string | null;
    recipient_user_login?: string | null;
    community_gift_id?: string | null;
  } | null;
  shared_chat_community_sub_gift?: {
    sub_plan?: string;
    total?: number;
    id?: string | null;
  } | null;
};

function handleChatNotification(event: ChatNotificationEvent, broadcast: BroadcastFn) {
  const noticeType = event.notice_type ?? "";
  const chatterName = event.chatter_user_name || event.chatter_user_login || "unknown";
  const chatterId = event.chatter_user_id || chatterName;
  const messageId = event.message_id || `${noticeType}_${Date.now()}`;

  if (noticeType === "sub" || noticeType === "shared_chat_sub") {
    const tier = event.sub?.sub_plan || event.shared_chat_sub?.sub_plan || "1000";
    addSubEvent({
      id: `eventsub_sub_${messageId}`,
      userId: chatterId,
      userName: chatterName,
      tier,
      isGift: false,
    });
    broadcast({ type: "sub", userName: chatterName, stats: currentStatsSnapshot(connected) });
    return;
  }

  if (noticeType === "resub" || noticeType === "shared_chat_resub") {
    const resub = event.resub || event.shared_chat_resub;
    const tier = resub?.sub_plan || "1000";
    const isGift = !!resub?.is_gift;
    if (isGift) {
      addGiftBatchEvent({
        id: `eventsub_resubgift_${messageId}`,
        total: 1,
        gifterId: resub?.gifter_is_anonymous ? null : resub?.gifter_user_id || null,
        gifterName: resub?.gifter_is_anonymous ? null : resub?.gifter_user_name || null,
      });
      broadcast({
        type: "gift",
        gifterName: resub?.gifter_is_anonymous ? "Anonymous" : (resub?.gifter_user_name || "unknown"),
        total: 1,
        stats: currentStatsSnapshot(connected),
      });
      return;
    }
    addSubEvent({
      id: `eventsub_resub_${messageId}`,
      userId: chatterId,
      userName: chatterName,
      tier,
      isGift: false,
    });
    broadcast({ type: "resub", userName: chatterName, stats: currentStatsSnapshot(connected) });
    return;
  }

  if (noticeType === "sub_gift" || noticeType === "shared_chat_sub_gift") {
    const gift = event.sub_gift || event.shared_chat_sub_gift;
    addGiftBatchEvent({
      id: `eventsub_gift_${messageId}`,
      total: 1,
      gifterId: event.chatter_is_anonymous ? null : chatterId,
      gifterName: event.chatter_is_anonymous ? null : chatterName,
    });
    broadcast({
      type: "gift",
      gifterName: event.chatter_is_anonymous ? "Anonymous" : chatterName,
      total: 1,
      stats: currentStatsSnapshot(connected),
    });
    return;
  }

  if (noticeType === "community_sub_gift" || noticeType === "shared_chat_community_sub_gift") {
    const gift = event.community_sub_gift || event.shared_chat_community_sub_gift;
    const total = gift?.total ?? 1;
    addGiftBatchEvent({
      id: `eventsub_community_gift_${messageId}`,
      total,
      gifterId: event.chatter_is_anonymous ? null : chatterId,
      gifterName: event.chatter_is_anonymous ? null : chatterName,
    });
    broadcast({
      type: "gift",
      gifterName: event.chatter_is_anonymous ? "Anonymous" : chatterName,
      total,
      stats: currentStatsSnapshot(connected),
    });
  }
}

async function createEventSubSubscription(type: string, condition: Record<string, string>) {
  if (!eventsubAuth || !eventsubSessionId) return;
  const res = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: {
      "Client-ID": CLIENT_ID,
      Authorization: `Bearer ${eventsubAuth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type,
      version: "1",
      condition,
      transport: {
        method: "websocket",
        session_id: eventsubSessionId,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`EventSub subscription failed for ${type}: ${res.status} ${text}`);
  }
}

async function subscribePublicModFeed() {
  if (!eventsubAuth) return;
  await createEventSubSubscription("channel.chat.notification", {
    broadcaster_user_id: eventsubAuth.broadcasterId,
    user_id: eventsubAuth.userId,
  });
}

type EventSubReady = {
  resolve: () => void;
  reject: (err: Error) => void;
  settled: boolean;
};

function connectEventSub(broadcast: BroadcastFn, url = EVENTSUB_WS, ready?: EventSubReady) {
  if (!eventsubAuth) return;
  const socket = new WebSocket(url);
  eventsubWs = socket;
  const version = ++eventsubSocketVersion;

  socket.onmessage = async (ev) => {
    if (eventsubWs !== socket || version !== eventsubSocketVersion) return;
    const msg = JSON.parse(String(ev.data)) as {
      metadata?: { message_type?: string; subscription_type?: string };
      payload?: {
        session?: { id?: string; reconnect_url?: string };
        subscription?: { type?: string };
        event?: ChatNotificationEvent;
      };
    };
    const messageType = msg.metadata?.message_type;

    if (messageType === "session_welcome") {
      eventsubSessionId = msg.payload?.session?.id || "";
      try {
        await subscribePublicModFeed();
        publicSubSource = "eventsub";
        console.log("[eventsub] public fruitberries mod feed enabled");
        if (ready && !ready.settled) {
          ready.settled = true;
          ready.resolve();
        }
      } catch (err) {
        console.error("[eventsub]", (err as Error).message);
        if (ready && !ready.settled) {
          ready.settled = true;
          ready.reject(err as Error);
        }
      }
      return;
    }

    if (messageType === "session_reconnect") {
      const reconnectUrl = msg.payload?.session?.reconnect_url;
      if (!reconnectUrl) return;
      socket.close();
      connectEventSub(broadcast, reconnectUrl, ready);
      return;
    }

    if (messageType === "notification" && msg.payload?.subscription?.type === "channel.chat.notification" && savedBroadcast) {
      handleChatNotification(msg.payload.event || {}, savedBroadcast);
      return;
    }

    if (messageType === "revocation") {
      publicSubSource = "irc";
      console.error("[eventsub] subscription revoked");
    }
  };

  socket.onclose = () => {
    if (eventsubWs !== socket || version !== eventsubSocketVersion) return;
    eventsubWs = null;
    eventsubSessionId = "";
    publicSubSource = "irc";
    if (ready && !ready.settled) {
      ready.settled = true;
      ready.reject(new Error("EventSub connection closed before subscription was ready"));
    }
    if (!eventsubAuth) return;
    eventsubReconnectTimer = setTimeout(() => connectEventSub(broadcast), 5000);
  };

  socket.onerror = () => {
    if (eventsubWs !== socket || version !== eventsubSocketVersion) return;
    console.error("[eventsub] websocket error");
  };
}

export function stopPublicModFeed() {
  if (eventsubReconnectTimer) {
    clearTimeout(eventsubReconnectTimer);
    eventsubReconnectTimer = null;
  }
  eventsubAuth = null;
  eventsubSessionId = "";
  publicSubSource = "irc";
  eventsubWs?.close();
  eventsubWs = null;
}

export async function startPublicModFeed(auth: {
  token: string;
  userId: string;
  broadcasterId: string;
}, broadcast: BroadcastFn) {
  stopPublicModFeed();
  savedBroadcast = broadcast;
  eventsubAuth = auth;
  await new Promise<void>((resolve, reject) => {
    connectEventSub(broadcast, EVENTSUB_WS, { resolve, reject, settled: false });
  });
}

export function connectIRC(broadcast: BroadcastFn) {
  if (!currentChannel) return;
  savedBroadcast = broadcast;
  const nick = `justinfan${Math.floor(Math.random() * 80000) + 10000}`;
  const socket = new WebSocket(IRC_WS);
  ws = socket;
  const version = ++socketVersion;
  let capAcked = false;

  socket.onopen = () => {
    if (ws !== socket || version !== socketVersion) return;
    socket.send("PASS SCHMOOPIIE");
    socket.send(`NICK ${nick}`);
    socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    console.log(`[irc] connecting to #${currentChannel} as ${nick}`);
  };

  socket.onmessage = (ev) => {
    if (ws !== socket || version !== socketVersion) return;
    for (const line of (ev.data as string).split("\r\n").filter(Boolean)) {
      const msg = parseIRC(line);

      switch (msg.command) {
        case "PING":
          socket.send(`PONG :${msg.trailing}`);
          break;

        case "CAP":
          if (!capAcked && msg.params[1] === "ACK") {
            capAcked = true;
            socket.send(`JOIN #${currentChannel}`);
            console.log(`[irc] CAP ACK — joining #${currentChannel}`);
          }
          break;

        case "001":
          connected = true;
          console.log(`[irc] ready on #${currentChannel}`);
          broadcast({ type: "connected", stats: currentStatsSnapshot(true) });
          break;

        case "USERNOTICE":
          onUserNotice(msg.tags, broadcast);
          break;

        case "PRIVMSG": {
          const bits = parseInt(msg.tags["bits"] || "0");
          if (bits > 0) {
            const isAnon = !msg.tags["user-id"];
            addBitEvent({
              id: `cheer_${msg.tags["id"] || Date.now()}`,
              userId:   isAnon ? null : msg.tags["user-id"],
              userName: isAnon ? null : (msg.tags["display-name"] || null),
              bits,
            });
            broadcast({ type: "bits", bits, stats: currentStatsSnapshot(connected) });
          }
          break;
        }

        case "NOTICE":
          if (msg.trailing.toLowerCase().includes("login unsuccessful")) {
            console.error("[irc] login failed — check credentials");
          }
          break;
      }
    }
  };

  socket.onclose = (ev) => {
    if (ws !== socket || version !== socketVersion) return;
    connected = false;
    broadcast({ type: "disconnected", stats: currentStatsSnapshot(false) });
    ws = null;
    if (currentChannel) {
      console.log(`[irc] closed (${ev.code}), retrying in 5s…`);
      reconnectTimer = setTimeout(() => connectIRC(broadcast), 5000);
    }
  };

  socket.onerror = () => {
    if (ws !== socket || version !== socketVersion) return;
    console.error("[irc] WebSocket error");
  };
}

export async function lookupChannel(login: string): Promise<{ id: string; login: string; displayName: string; avatarUrl: string } | null> {
  if (!appToken) return null;
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?login=${login}`, {
      headers: { "Client-ID": CLIENT_ID, Authorization: `Bearer ${appToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { id: string; login: string; display_name: string; profile_image_url: string }[] };
    const u = data.data?.[0];
    if (!u) return null;
    return { id: u.id, login: u.login, displayName: u.display_name, avatarUrl: u.profile_image_url };
  } catch {
    return null;
  }
}

export async function switchChannel(channel: string, broadcast: BroadcastFn) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const prev = ws;
  ws = null;
  prev?.close();
  connected = false;
  currentChannel = channel.toLowerCase();
  connectIRC(broadcast);
}

export function setStatsProvider(provider: (connected: boolean) => unknown) {
  statsProvider = provider;
}

export async function initTwitch(broadcast: BroadcastFn, channel?: string) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  ws?.close();
  ws = null;
  connected = false;

  try {
    appToken = await getAppToken();
    console.log("[twitch] app token acquired");
  } catch (err) {
    console.error("[twitch] app token failed:", (err as Error).message);
  }

  if (channel) {
    currentChannel = channel.toLowerCase();
    connectIRC(broadcast);
  }
}
