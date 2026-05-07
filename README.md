# slack-plugin

A Claude Code plugin that bridges Slack into your session. The bot listens
over Slack's WebSocket (Socket Mode via [@slack/bolt](https://docs.slack.dev/tools/bolt-js/))
and forwards inbound messages to Claude as `<channel>` events; Claude can
reply, react, or send unsolicited messages back through three MCP tools.

This is the Slack-flavored sibling of
[`whatsapp-plugin`](https://github.com/Buzzie-AI/whatsapp-plugin) — same
shape, different platform.

## Install

In Claude Code:

```
/plugin marketplace add Buzzie-AI/slack-plugin
/plugin install slack@buzzie-ai
```

Then follow the [Setup](#setup) section below to create the Slack app and
paste tokens.

---

## What it does

- **Forwards Slack messages to Claude** as `<channel source="plugin:slack:slack" ...>` events:
  - DMs to the bot (open access — anyone in the workspace can DM)
  - `@claude` mentions in any channel the bot is in (always-forward)
  - Channel messages matching configured text-prefix regexes (e.g., `!c restart`)
- **Lets Claude respond** through three MCP tools:
  - `reply` — reply to an inbound message; auto-threads in channels
  - `react` — add an emoji reaction
  - `send` — unsolicited message (cron alerts, autopilot pings); defaults to operator DM

---

## Setup

### 1. Create a Slack app

Go to https://api.slack.com/apps → "Create New App" → "From an app manifest"
and use this manifest (also shown by `/slack:configure link`):

```yaml
display_information:
  name: Claude
  description: Claude Code channel bridge
features:
  bot_user:
    display_name: Claude
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - reactions:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

### 2. Capture two tokens

- **Bot token** (`xoxb-...`) — *OAuth & Permissions* → *Install to Workspace* → *Bot User OAuth Token*.
- **App-level token** (`xapp-...`) — *Basic Information* → *App-Level Tokens* → *Generate Token*. Add the `connections:write` scope.

### 3. Paste tokens

Inside Claude Code:

```
/slack:configure set-tokens xoxb-... xapp-...
```

This writes `~/.slack-cli/auth/tokens.json` (mode 0600) and tells you to restart.

### 4. (Optional) Set installer user_id

To strictly gate permission verdicts to your account:

```
/slack:configure set-installer Uxxx
```

You can find your `Uxxx` after the first DM by tailing `~/.claude/channels/slack/server.log`.

### 5. Restart Claude Code

The MCP server picks up the new tokens at boot.

---

## Daily use

- **DM the bot** in Slack → Claude sees it as `kind="dm"`.
- **Invite the bot to a channel** (`/invite @claude` in Slack) → it can listen there.
- **`@claude` in a channel** → always forwarded.
- **`!c <message>` in a channel** → forwarded if you've configured the prefix:

  ```
  /slack:access prefix add ^!c\b
  ```

- **Per-channel prefix overrides:**

  ```
  /slack:access channel C0DEPLOY prefix add ^deploy:
  ```

  The per-channel list **replaces** the global list for that channel; if you
  want both, add both to the channel.

- **Status check:**

  ```
  /slack:configure         # auth + access summary
  /slack:access            # current prefixes
  ```

- **Live logs:**

  ```
  tail -f ~/.claude/channels/slack/server.log
  ```

---

## Tools (what Claude can call)

| Tool | When available | Purpose |
|---|---|---|
| `reply` | Channel-gated (only on turns with an inbound `<channel>` event) | Reply to the message; auto-threads in channels |
| `react` | Channel-gated | Add an emoji (e.g., `eyes`, `white_check_mark`) |
| `send` | Always | Unsolicited message — defaults to the operator DM if `installerUserId` is set |

`reply` auto-fills `thread_ts` from the inbound message so channel responses
stay tidy. To break out of a thread, pass `thread_ts: ""` explicitly.

---

## Permission relay

When Claude tries to use a tool that needs approval, the plugin DMs the
permission prompt to the most recent inbound chat. Reply `yes <id>` or
`no <id>` to approve/deny — the verdict is honored only from the same
trusted sender (the installer if set, else the originator of the request).

---

## State files

| Path | Owned by | Purpose |
|---|---|---|
| `~/.slack-cli/auth/tokens.json` | `/slack:configure` | bot + app tokens; cached `teamId`, `botUserId`, `installerUserId` |
| `~/.claude/channels/slack/access.json` | `/slack:access` | global + per-channel prefix regexes |
| `~/.claude/channels/slack/server.log` | server | rotating log (5MB) |

---

## Architecture (one file)

`server.mjs` is a single Node.js process that:

1. Acquires an advisory lock on the auth dir (`proper-lockfile`) so two
   instances can't double-deliver.
2. Starts an MCP stdio server (`@modelcontextprotocol/sdk`).
3. Starts a Bolt App in Socket Mode and subscribes to `message`, `app_mention`.
4. Funnels every inbound event through one `handleInbound` that gates by
   `kind`, runs the prefix check for channel messages, dedups against
   `app_mention`, parses permission verdicts, and forwards as
   `mcp.notification('notifications/claude/channel', { content, meta })`.
5. Exposes `reply` / `react` / `send` as MCP tools, all routing through
   `chat.postMessage` / `reactions.add` with consistent logging.

If `~/.slack-cli/auth/tokens.json` is missing, the MCP server still boots
(tools error with a "not connected" message); Bolt simply doesn't start.

---

## License

Apache-2.0.
