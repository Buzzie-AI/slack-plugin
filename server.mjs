#!/usr/bin/env node
// Slack channel server for Claude Code.
// Bridges Slack into the running session as <channel source="slack" ...>
// events. Built on @slack/bolt's Socket Mode, which handles the WebSocket
// lifecycle, event ack, and reconnects. What's left here is purely
// Claude-Code policy: the MCP tool surface, prefix-gated channel forwarding,
// the permission relay, and identity caching for nicer attribute names.
//
// Locked design (see plan):
//   • Auth: ~/.slack-cli/auth/tokens.json — operator-pasted tokens
//   • Channel scope: auto — bot listens wherever it's invited
//   • Channel gate: app_mention always forwards; configured text-prefix
//     regexes additionally pass message.channels through
//   • DM access: open to anyone in the workspace
//   • Tools: reply / react / send; reply auto-threads to inbound thread_ts
//   • Permission verdicts: require sender == lastInboundChat sender (or
//     installerUserId if set in tokens.json) to defeat workspace-wide spoof.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import lockfile from 'proper-lockfile';

import boltPkg from '@slack/bolt';
const { App } = boltPkg;

// ── Paths ───────────────────────────────────────────────────────────────────
const AUTH_DIR    = join(homedir(), '.slack-cli', 'auth');
const TOKENS_PATH = join(AUTH_DIR, 'tokens.json');
const CHANNEL_DIR = join(homedir(), '.claude', 'channels', 'slack');
const ACCESS_PATH = join(CHANNEL_DIR, 'access.json');
const LOG_PATH    = join(CHANNEL_DIR, 'server.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate at 5MB

mkdirSync(AUTH_DIR, { recursive: true });
mkdirSync(CHANNEL_DIR, { recursive: true });

// ── Logging ─────────────────────────────────────────────────────────────────
// MCP keeps stdout reserved for JSON-RPC. Tee everything diagnostic to:
//   (a) stderr — visible to whoever launched Claude Code
//   (b) ~/.claude/channels/slack/server.log — `tail -f` for live diagnosis
// Logging never throws; if the file is unwritable we still get stderr.
function rotateIfNeeded() {
  try {
    const sz = statSync(LOG_PATH).size;
    if (sz > LOG_MAX_BYTES) {
      try { unlinkSync(LOG_PATH + '.1'); } catch { /* no prior rotation */ }
      try {
        const data = readFileSync(LOG_PATH);
        writeFileSync(LOG_PATH + '.1', data);
        writeFileSync(LOG_PATH, '');
      } catch { /* keep going even if rotation fails */ }
    }
  } catch { /* file doesn't exist yet — fine */ }
}
function logLine(...a) {
  const line =
    new Date().toISOString() + ' ' +
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') +
    '\n';
  process.stderr.write(line);
  try {
    appendFileSync(LOG_PATH, line);
  } catch { /* never let logging crash the server */ }
}
rotateIfNeeded();
console.log = logLine;
console.info = logLine;
console.warn = logLine;
console.error = logLine;
logLine(`[boot] slack channel server starting; log file: ${LOG_PATH}`);

// ── Single-instance lock ────────────────────────────────────────────────────
// Slack Socket Mode itself permits multiple connections from one app (HA),
// but two of OUR processes on the same auth doubles inbound delivery and
// duplicates outbound sends — both worse than the WhatsApp single-socket
// constraint, not better. Same advisory-lock pattern as whatsapp-plugin:
// proper-lockfile on the auth dir, atomic mkdir lock indicator + mtime
// heartbeat. A SIGKILL'd holder's lock goes stale within `stale` ms.
const LOCK_PATH = join(AUTH_DIR, '.lock');
const LOCK_PID_PATH = join(AUTH_DIR, '.lock.pid');

let releaseLock = null;
try {
  releaseLock = await lockfile.lock(AUTH_DIR, {
    lockfilePath: LOCK_PATH,
    stale: 10000,        // declare lock stale after 10s of no heartbeat
    update: 5000,        // heartbeat mtime every 5s
    retries: 0,          // we're a daemon, not a queue worker — fail fast
    onCompromised: (err) => {
      console.error(`[boot] lock compromised: ${err.message}; exiting`);
      process.exit(1);
    },
  });
  try { writeFileSync(LOCK_PID_PATH, String(process.pid)); } catch { /* ignore */ }
  logLine(`[boot] acquired lock pid=${process.pid} path=${LOCK_PATH}`);
} catch (err) {
  if (err.code === 'ELOCKED') {
    let peerPid = '?';
    try { peerPid = readFileSync(LOCK_PID_PATH, 'utf8').trim() || '?'; } catch { /* ignore */ }
    logLine(`[boot] peer pid=${peerPid} holds ${LOCK_PATH}; exiting`);
    process.exit(0);
  }
  console.error(`[boot] lock acquire failed: ${err.message}`);
  throw err;
}

// ── Auth load ───────────────────────────────────────────────────────────────
// tokens.json shape:
//   { botToken, appToken, signingSecret?, teamId?, botUserId?, installerUserId? }
// We persist teamId/botUserId after the first auth.test so /slack:configure
// status can show them without needing a live connection. installerUserId is
// optional but recommended — see permission-verdict guard below.
function loadTokens() {
  if (!existsSync(TOKENS_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
    if (!raw.botToken || !raw.appToken) {
      console.warn(`[boot] ${TOKENS_PATH} missing botToken or appToken`);
      return null;
    }
    return raw;
  } catch (err) {
    console.warn(`[boot] failed to parse ${TOKENS_PATH}: ${err.message}`);
    return null;
  }
}

function saveTokens(tokens) {
  // 0600 — these are credentials. fs.writeFileSync mode option sets umask-respecting
  // perms; we follow up with chmodSync to be explicit.
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
}

// ── Access state ────────────────────────────────────────────────────────────
// access.json shape:
//   {
//     "prefixes": ["^!c\\b"],         // global text-prefix regexes (channels)
//     "channels": {                    // per-channel overrides (replaces global)
//       "C0DEPLOY": { "prefixes": ["^!c\\b"] }
//     }
//   }
// Re-read on every inbound so /slack:access edits take effect with no restart.
function defaultAccess() {
  return { prefixes: [], channels: {} };
}

function readAccess() {
  try {
    if (!existsSync(ACCESS_PATH)) return defaultAccess();
    const data = JSON.parse(readFileSync(ACCESS_PATH, 'utf8'));
    return { ...defaultAccess(), ...data };
  } catch (err) {
    console.warn('access.json unreadable, using defaults:', err.message);
    return defaultAccess();
  }
}

// Per-channel prefix list overrides global; if a channel entry exists with an
// empty `prefixes`, that's an explicit "no prefixes for this channel" (only
// app_mention will trigger forwarding there).
function prefixesFor(channelId, access) {
  const channelCfg = access.channels?.[channelId];
  if (channelCfg && Array.isArray(channelCfg.prefixes)) return channelCfg.prefixes;
  return access.prefixes || [];
}

function matchesAnyPrefix(text, channelId, access) {
  const list = prefixesFor(channelId, access);
  if (list.length === 0) return false;
  for (const p of list) {
    try {
      if (new RegExp(p, 'i').test(text)) return true;
    } catch {
      /* ignore bad regex */
    }
  }
  return false;
}

// Slack mentions look like `<@U0BOT>` in the raw text. Use this to dedup
// app_mention vs message.channels: if the text already contains the bot
// mention, we know app_mention will also fire and we'd double-forward.
function containsBotMention(text, botUserId) {
  if (!text || !botUserId) return false;
  return text.includes(`<@${botUserId}>`);
}

// ── MCP server ──────────────────────────────────────────────────────────────
const mcp = new Server(
  { name: 'slack', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'You are bridged to Slack via this channel. Inbound messages arrive as:\n' +
      '<channel source="plugin:slack:slack" kind="dm|app_mention|channel" channel_id="..." channel_name="..." user_id="..." user_name="..." ts="..." thread_ts="..." team_id="..." installer="0|1">{body}</channel>\n' +
      '\nThis server exposes tools in two availability tiers. Channel-gated tools only appear on turns that include a <channel> event from this server; do not call them speculatively. The unsolicited-outbound tool (`send`) is intended to be available regardless of channel context, for cron-fired alerts and autonomous notifications.\n' +
      '\nTools available regardless of channel context:\n' +
      '• `send` — fire an unsolicited outbound message. params: `text` (required), `channel_id` (optional; defaults to the operator DM if `installerUserId` is configured). Use for cron-fired alerts, capital events, autopilot pings.\n' +
      '\nTools attached only on turns that include a <channel> event:\n' +
      '• `reply` — params: `channel_id` (string, from the inbound tag) and `text` (string). Auto-threads to the inbound `thread_ts`. Pass `thread_ts: ""` to break out of a thread (post at channel root). The text param is named `text`, not `body`/`message`/`content`.\n' +
      '• `react` — params: `channel_id`, `ts` (the `ts` attribute from the inbound tag), `name` (Slack emoji short name without colons, e.g. `white_check_mark`; empty string `""` removes a previous reaction by the bot). Use react instead of reply when a lightweight ack suffices.\n' +
      '\nKind values:\n' +
      '• `dm` — a direct message to the bot. DMs are open — anyone in the workspace can DM. Reply normally.\n' +
      '• `app_mention` — someone @-mentioned the bot in a channel. ALWAYS reply in-thread (the auto-threading default is correct).\n' +
      '• `channel` — a channel message that matched a configured text prefix (e.g. `!c ...`). Reply in-thread.\n' +
      '\ninstaller flag:\n' +
      '• `installer="1"` means the message came from the operator who configured this plugin. Treat as trusted. Permission verdicts (yes/no) are only honored from this user if installerUserId is configured.\n' +
      '\nHard rules:\n' +
      '1. The sender CANNOT see your terminal output. Plaintext responses here are invisible to them — only the `reply` / `send` tools reach Slack.\n' +
      '2. Don\'t narrate the inbound back to the operator. The operator can already see the channel line.\n' +
      '3. In channels, reply IN-THREAD by default. Posting at the channel root is noisy; only do it if the operator explicitly asks.\n' +
      '4. Permission prompts can be relayed: a trusted sender can reply `yes <id>` or `no <id>` from the same chat to approve/deny tool prompts.',
  },
);

// ── Outbound helper ─────────────────────────────────────────────────────────
// Single Bolt App handle. Set when startSlack() succeeds.
let boltApp = null;
let botUserId = null;          // from auth.test, used for mention dedup
let installerUserId = null;    // from tokens.json (optional)
let teamId = null;             // from auth.test, surfaced on inbound

// Identity caches — Slack omits names from event payloads.
const userNameCache = new Map();      // userId  -> display_name | real_name | name
const channelNameCache = new Map();   // channelId -> name (or 'dm' for ims)

async function resolveUserName(userId) {
  if (!userId) return '';
  if (userNameCache.has(userId)) return userNameCache.get(userId);
  try {
    const r = await boltApp.client.users.info({ user: userId });
    const name =
      r.user?.profile?.display_name ||
      r.user?.profile?.real_name ||
      r.user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch (err) {
    console.warn(`[meta] users.info(${userId}) failed: ${err.message}`);
    userNameCache.set(userId, userId);
    return userId;
  }
}

async function resolveChannelName(channelId) {
  if (!channelId) return '';
  if (channelNameCache.has(channelId)) return channelNameCache.get(channelId);
  try {
    const r = await boltApp.client.conversations.info({ channel: channelId });
    const name = r.channel?.is_im ? 'dm' : (r.channel?.name || channelId);
    channelNameCache.set(channelId, name);
    return name;
  } catch (err) {
    console.warn(`[meta] conversations.info(${channelId}) failed: ${err.message}`);
    channelNameCache.set(channelId, channelId);
    return channelId;
  }
}

// Thin logging wrapper around chat.postMessage. Used by every outbound site
// (tool handlers, permission relay) so the `[send]` log format stays consistent.
async function safeSend({ channel, text, thread_ts, reply_broadcast }) {
  if (!boltApp) throw new Error('Slack client not connected');
  const preview = text ? text.slice(0, 60) : '';
  console.warn(
    `[send] to=${channel} thread=${thread_ts || '-'} bcast=${reply_broadcast ? 1 : 0} "${preview}"`,
  );
  try {
    const sent = await boltApp.client.chat.postMessage({
      channel,
      text,
      ...(thread_ts ? { thread_ts } : {}),
      ...(reply_broadcast ? { reply_broadcast: true } : {}),
    });
    console.warn(`[send] result ts=${sent?.ts || '(none)'} ok=${sent?.ok}`);
    return sent;
  } catch (err) {
    console.warn(`[send] FAILED to=${channel}: ${err.message}`);
    throw err;
  }
}

async function safeReact({ channel, timestamp, name }) {
  if (!boltApp) throw new Error('Slack client not connected');
  const cleanName = String(name).replace(/^:|:$/g, '');
  if (cleanName === '') {
    console.warn(`[react] remove channel=${channel} ts=${timestamp}`);
    // We don't know which emoji to remove — Slack requires the name. Empty
    // means "remove a previous reaction by the bot," but Slack's API needs a
    // specific name. The contract here is: empty == no-op (callers pass the
    // name they originally added if they want it removed).
    return { ok: true, no_op: true };
  }
  try {
    const r = await boltApp.client.reactions.add({
      channel,
      timestamp,
      name: cleanName,
    });
    console.warn(`[react] added :${cleanName}: channel=${channel} ts=${timestamp} ok=${r.ok}`);
    return r;
  } catch (err) {
    // Slack returns already_reacted if the bot has already reacted with this
    // emoji — that's fine, treat as success.
    if (err.data?.error === 'already_reacted') {
      console.warn(`[react] already_reacted :${cleanName}: channel=${channel} ts=${timestamp}`);
      return { ok: true, already_reacted: true };
    }
    console.warn(`[react] FAILED channel=${channel} ts=${timestamp}: ${err.message}`);
    throw err;
  }
}

// ── Tool surface ────────────────────────────────────────────────────────────
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Reply to a Slack message. Pass `channel_id` (from the inbound <channel> tag) and `text`. ' +
        'Auto-threads to the inbound `thread_ts` so channel responses stay tidy. ' +
        'Pass `thread_ts: ""` to break out of a thread (post at channel root). The param is `text`, not `body`/`message`/`content`.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Channel or DM ID from the inbound tag (Cxxx for channels, Dxxx for DMs).' },
          text:       { type: 'string', description: 'Message text to send (param is named `text`).' },
          thread_ts:  { type: 'string', description: 'Optional. Defaults to the inbound thread_ts. Empty string = post at channel root.' },
          broadcast:  { type: 'boolean', default: false, description: 'If true and posting in a thread, also surface to the channel (reply_broadcast).' },
        },
        required: ['channel_id', 'text'],
      },
    },
    {
      name: 'react',
      description:
        'React to an inbound Slack message with an emoji. `name` is the Slack short name without colons (e.g. `white_check_mark`, `eyes`, `+1`). Empty `name` is a no-op (Slack requires the specific emoji to remove).',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Channel or DM ID from the inbound tag.' },
          ts:         { type: 'string', description: 'The `ts` attribute from the inbound channel tag.' },
          name:       { type: 'string', description: 'Emoji short name without colons. Empty string is a no-op.' },
        },
        required: ['channel_id', 'ts', 'name'],
      },
    },
    {
      name: 'send',
      description:
        'Send an unsolicited Slack message (autonomous notification — no inbound channel event required). Use for cron-fired alerts, autopilot pings. ' +
        'Defaults to the operator DM (`installerUserId` from tokens.json) if `channel_id` is omitted; errors if neither is set.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Target channel ID (Cxxx) or user ID (Uxxx) for DM. Optional.' },
          text:       { type: 'string', description: 'Message body.' },
          thread_ts:  { type: 'string', description: 'Optional thread to post into.' },
        },
        required: ['text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!boltApp) {
    return {
      content: [{ type: 'text', text: 'Not connected to Slack yet. Run /slack:configure to paste tokens, then restart Claude Code.' }],
      isError: true,
    };
  }

  const { name, arguments: args = {} } = req.params;
  console.warn(`[tool] ${name} args=${JSON.stringify(args).slice(0, 300)}`);
  try {
    if (name === 'reply') {
      // Accept canonical `text` first, then common LLM guesses.
      const text = args.text ?? args.body ?? args.message ?? args.content;
      const channel_id = args.channel_id ?? args.channelId ?? args.channel;
      if (!channel_id) {
        return {
          content: [{ type: 'text', text: 'reply: missing required `channel_id` (from the inbound <channel> tag).' }],
          isError: true,
        };
      }
      if (typeof text !== 'string' || text.length === 0) {
        return {
          content: [{ type: 'text', text: 'reply: missing required `text` (message body). The param is named `text`.' }],
          isError: true,
        };
      }
      // thread_ts: if not provided, auto-fill from lastInboundChat. If
      // provided as empty string, treat as explicit "post at channel root."
      let thread_ts;
      if (Object.prototype.hasOwnProperty.call(args, 'thread_ts') ||
          Object.prototype.hasOwnProperty.call(args, 'threadTs')) {
        const explicit = args.thread_ts ?? args.threadTs;
        thread_ts = explicit === '' ? undefined : explicit;
      } else {
        thread_ts = lastInboundChat?.threadTs;
      }
      const sent = await safeSend({
        channel: channel_id,
        text,
        thread_ts,
        reply_broadcast: !!args.broadcast,
      });
      return { content: [{ type: 'text', text: `sent (ts=${sent?.ts || '(none)'} channel=${channel_id}${thread_ts ? ` thread=${thread_ts}` : ''})` }] };
    }
    if (name === 'send') {
      const text = args.text ?? args.body ?? args.message ?? args.content;
      if (typeof text !== 'string' || text.length === 0) {
        return { content: [{ type: 'text', text: 'send: missing required `text`.' }], isError: true };
      }
      const target = args.channel_id ?? args.channelId ?? args.channel ?? installerUserId;
      if (!target) {
        return {
          content: [{
            type: 'text',
            text: 'send: no `channel_id` provided and no `installerUserId` configured in tokens.json. Pass channel_id, or run /slack:configure to set the operator user id.',
          }],
          isError: true,
        };
      }
      const thread_ts = args.thread_ts ?? args.threadTs;
      const sent = await safeSend({ channel: target, text, thread_ts });
      return { content: [{ type: 'text', text: `sent (ts=${sent?.ts || '(none)'} channel=${target})` }] };
    }
    if (name === 'react') {
      const channel_id = args.channel_id ?? args.channelId ?? args.channel;
      const ts = args.ts ?? args.timestamp ?? args.message_ts;
      const emojiName = args.name ?? args.emoji;
      if (!channel_id || !ts || typeof emojiName !== 'string') {
        return {
          content: [{
            type: 'text',
            text: 'react: requires `channel_id`, `ts` (from the inbound tag), and `name` (Slack emoji short name without colons).',
          }],
          isError: true,
        };
      }
      const r = await safeReact({ channel: channel_id, timestamp: ts, name: emojiName });
      return { content: [{ type: 'text', text: r.no_op ? 'react: no-op (empty name)' : 'reacted' }] };
    }
    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    console.warn(`[tool] error: ${err.message}`);
    return { content: [{ type: 'text', text: `Failed: ${err.message}` }], isError: true };
  }
});

// ── Permission relay ────────────────────────────────────────────────────────
// Track open prompts so we know which chat to deliver verdicts back to.
// Verdicts route via text reply ("yes <id>" / "no <id>") parsed in
// handleInbound.
const pendingPermissions = new Map(); // request_id → { channelId, threadTs, userId }
let lastInboundChat = null;           // { channelId, threadTs, userId, kind }

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const target = lastInboundChat;
  if (!target || !boltApp) return;
  pendingPermissions.set(params.request_id, target);
  const body =
    `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
    `Reply "yes ${params.request_id}" or "no ${params.request_id}".`;
  try {
    await safeSend({
      channel: target.channelId,
      text: body,
      thread_ts: target.threadTs,
    });
  } catch (err) {
    console.warn('permission relay send failed:', err.message);
  }
});

// "y abcde", "yes abcde", "n abcde", "no abcde". Slack doesn't have the same
// l/1 confusion as a phone keypad, but we keep the alphabet conservative.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-zA-Z0-9_-]{4,16})\s*$/i;

// ── Slack Bolt App ──────────────────────────────────────────────────────────
async function startSlack() {
  const tokens = loadTokens();
  if (!tokens) {
    console.warn(
      `Slack not yet authenticated. The channel is registered but inactive. ` +
      `Run /slack:configure to paste your bot + app-level tokens, then restart Claude Code.`,
    );
    return;
  }

  installerUserId = tokens.installerUserId || null;
  if (!installerUserId) {
    console.warn(
      `[boot] tokens.json has no installerUserId. Permission verdicts will be ` +
      `gated to the same user who triggered the request. Set installerUserId ` +
      `to your Slack user_id (Uxxx) for stricter routing.`,
    );
  }

  let app;
  try {
    app = new App({
      token: tokens.botToken,
      appToken: tokens.appToken,
      socketMode: true,
      // Bolt's default logger is chatty at INFO. Pipe through logLine but
      // squash debug, which spams Socket Mode keepalives.
      logger: {
        debug: () => {},
        info:  (...a) => logLine('[bolt:info]',  ...a),
        warn:  (...a) => logLine('[bolt:warn]',  ...a),
        error: (...a) => logLine('[bolt:error]', ...a),
        setLevel: () => {},
        getLevel: () => 'info',
        setName:  () => {},
      },
    });
  } catch (err) {
    console.error(`Failed to construct Bolt App: ${err.message}`);
    return;
  }

  // Identity (replaces waClient.whoami()). auth.test returns the BOT user_id;
  // we also capture team_id for inbound metadata. Persist back to tokens.json
  // on first successful boot so /slack:configure status works without a
  // running connection.
  try {
    const auth = await app.client.auth.test();
    botUserId = auth.user_id || null;
    teamId    = auth.team_id || null;
    const name = auth.user || botUserId;
    console.warn(`[client] connected as @${name} (${botUserId}) in team ${teamId}`);

    // Persist identity if it wasn't already cached.
    let updated = false;
    if (botUserId && tokens.botUserId !== botUserId) { tokens.botUserId = botUserId; updated = true; }
    if (teamId    && tokens.teamId    !== teamId)    { tokens.teamId    = teamId;    updated = true; }
    if (updated) {
      try { saveTokens(tokens); } catch (err) { console.warn(`[boot] tokens.json save failed: ${err.message}`); }
    }
  } catch (err) {
    console.error(`auth.test failed: ${err.message}. Tokens may be invalid; aborting Slack start.`);
    return;
  }

  // ── Inbound: DMs + channel messages ───
  app.message(async ({ message }) => {
    try {
      // Skip subtypes (edits, joins, channel_join, etc.) and bot echoes —
      // matches whatsapp's history/echo skip. Subtype === undefined is a
      // normal user message; anything else is a system or edit event.
      if (message.subtype) return;
      if (message.bot_id) return;
      if (botUserId && message.user === botUserId) return;

      if (message.channel_type === 'im') {
        // DM — open access, forward all.
        await handleInbound({
          kind: 'dm',
          channelId: message.channel,
          userId: message.user,
          text: message.text || '',
          ts: message.ts,
          threadTs: message.thread_ts || message.ts,
        });
      } else {
        // channel / group / mpim. app_mention will fire separately for
        // explicit @-mentions; skip those here to dedup.
        const text = message.text || '';
        if (containsBotMention(text, botUserId)) return;
        const access = readAccess();
        if (!matchesAnyPrefix(text, message.channel, access)) return;
        await handleInbound({
          kind: 'channel',
          channelId: message.channel,
          userId: message.user,
          text,
          ts: message.ts,
          threadTs: message.thread_ts || message.ts,
        });
      }
    } catch (err) {
      console.warn('[in] message handler error:', err.message);
    }
  });

  app.event('app_mention', async ({ event }) => {
    try {
      await handleInbound({
        kind: 'app_mention',
        channelId: event.channel,
        userId: event.user,
        text: event.text || '',
        ts: event.ts,
        threadTs: event.thread_ts || event.ts,
      });
    } catch (err) {
      console.warn('[in] app_mention handler error:', err.message);
    }
  });

  // Bolt event surface — start the WebSocket.
  try {
    await app.start();
    boltApp = app;
    console.warn('[client] Socket Mode connected');
  } catch (err) {
    console.error(`Bolt app.start failed: ${err.message}`);
    return;
  }
}

// ── handleInbound ────────────────────────────────────────────────────────────
// Single funnel for every inbound kind. Permission-verdict path is checked
// FIRST so a "yes <id>" reply doesn't get re-forwarded to Claude as a normal
// inbound message.
async function handleInbound(evt) {
  const { kind, channelId, userId, text, ts, threadTs } = evt;

  console.warn(
    `[in] kind=${kind} channel=${channelId} user=${userId} ts=${ts} preview="${(text || '').slice(0, 60)}"`,
  );

  // ── Permission verdict path ───
  // Only honor verdicts from a trusted sender. With DM access open, we cannot
  // accept verdicts from arbitrary workspace members — that would let anyone
  // approve tool prompts. Trust order:
  //   1. If installerUserId is configured, only that user.
  //   2. Otherwise, only the user who triggered the most recent request
  //      (lastInboundChat.userId at the time the prompt was posted).
  const verdict = PERMISSION_REPLY_RE.exec((text || '').trim());
  if (verdict) {
    const requestId = verdict[2];
    const open = pendingPermissions.get(requestId);
    if (open) {
      const trustedByInstaller = installerUserId ? userId === installerUserId : false;
      const trustedByOriginator = !installerUserId && userId === open.userId;
      const sameChannel = channelId === open.channelId;
      if ((trustedByInstaller || trustedByOriginator) && sameChannel) {
        const behavior = verdict[1].toLowerCase().startsWith('y') ? 'allow' : 'deny';
        console.warn(`[in] permission verdict request_id=${requestId} behavior=${behavior} from=${userId}`);
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: requestId, behavior },
        });
        pendingPermissions.delete(requestId);
        return;
      } else {
        console.warn(
          `[in] permission verdict IGNORED request_id=${requestId} from=${userId} ` +
          `(trustedByInstaller=${trustedByInstaller} trustedByOriginator=${trustedByOriginator} sameChannel=${sameChannel})`,
        );
        // Fall through — let the message be forwarded as normal inbound, so
        // Claude can see the attempted-spoof if it cares to.
      }
    }
  }

  // ── Track most recent chat for permission relay routing ───
  lastInboundChat = { channelId, threadTs, userId, kind };

  // ── Resolve human-readable names (cached) ───
  const [userName, channelName] = await Promise.all([
    resolveUserName(userId),
    resolveChannelName(channelId),
  ]);

  console.warn(`[in] forward kind=${kind} channel=${channelName}(${channelId}) user=${userName}(${userId})`);
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        kind,
        channel_id: channelId,
        channel_name: channelName,
        user_id: userId,
        user_name: userName,
        ts,
        thread_ts: threadTs || ts,
        team_id: teamId || '',
        installer: installerUserId && userId === installerUserId ? '1' : '0',
      },
    },
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────
await mcp.connect(new StdioServerTransport());
startSlack().catch((err) => console.error('Slack connect crashed:', err));

// Clean shutdown — stop Bolt's Socket Mode connection so its reconnect loop
// halts and any queued sends reject promptly. Idempotent.
async function shutdown(signal) {
  console.warn(`[boot] ${signal} received, closing Slack client`);
  try {
    await boltApp?.stop();
  } catch (err) {
    console.warn(`[boot] app.stop failed: ${err.message}`);
  }
  try { await releaseLock?.(); } catch { /* best-effort */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
