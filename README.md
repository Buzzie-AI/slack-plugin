# Claude Code Slack Channel

A Slack [channel plugin](https://code.claude.com/docs/en/channels) for Claude
Code. Receive Slack DMs and channel messages in your running session and
reply through the same chat — like a chat bridge between Slack and your
local terminal.

```text
/plugin marketplace add Buzzie-AI/slack-plugin
/plugin install slack@buzzie-ai
```

Built on [@slack/bolt](https://docs.slack.dev/tools/bolt-js/) Socket Mode.
No public webhook URL, no inbound HTTP — your bot opens a WebSocket from
your machine to Slack and stays connected.

## What it does

- **DMs as a remote control.** DM the bot in Slack; the message arrives in
  your running Claude Code session as a `<channel>` event. Claude acts on
  it and replies back through the same DM. DM access is open — anyone in
  the workspace can DM the bot.
- **Channel messages, prefix-gated.** Invite the bot to a channel
  (`/invite @claude`); messages addressed to it forward through. Two ways
  to address the bot:
  - **`@claude` mention** — always forwards (Slack's native `app_mention`).
  - **Custom text prefix** — opt in per-channel via `/slack:access prefix
    add ^!c\b`, then `!c restart deploys` will forward.
- **Auto-threading.** Replies in channels post to the inbound message's
  thread by default, so Claude's responses stay attached to context.
- **Permission relay.** When Claude tries to run a tool that needs approval,
  the prompt is forwarded through Slack; reply `yes <id>` or `no <id>` from
  the same chat to allow or deny.

## Requirements

- Claude Code v2.1.80+ with a claude.ai login (channels are not available on
  Console / API-key auth).
- Node.js 20+ (the channel server runs under Node).
- A Slack workspace where you can install a custom app (Workspace Owner or
  permission to install apps).

## Setup

### 1. Install the plugin

In Claude Code:

```text
/plugin marketplace add Buzzie-AI/slack-plugin
/plugin install slack@buzzie-ai
```

The first command registers this repo as a marketplace; the second installs
the `slack` plugin from it.

### 2. Create a Slack app and capture two tokens

Go to https://api.slack.com/apps → *Create New App* → *From an app manifest*
and paste the manifest below (also shown by `/slack:configure link`):

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

Then capture the two tokens:

- **Bot token** (`xoxb-...`) — *OAuth & Permissions* → *Install to Workspace*
  → *Bot User OAuth Token*.
- **App-level token** (`xapp-...`) — *Basic Information* → *App-Level Tokens*
  → *Generate Token and Scopes*. Add the `connections:write` scope.

Paste both into the plugin in your terminal Claude Code session:

```text
/slack:configure set-tokens xoxb-... xapp-...
```

This writes `~/.slack-cli/auth/tokens.json` (mode 0600). To strictly gate
permission verdicts to your account, also run:

```text
/slack:configure set-installer Uxxx
```

(Your Slack user ID. If you don't know it, skip this step now — DM the bot
once after step 4 and your `Uxxx` shows up in the log.)

### 3. Restart Claude Code with the channel enabled

```bash
claude --channels plugin:slack@buzzie-ai
```

> **Heads up — research-preview channels.** Custom channels are not yet on
> Claude Code's approved allowlist. If `--channels plugin:slack@buzzie-ai`
> errors, run with `--dangerously-load-development-channels plugin:slack@buzzie-ai`
> until the flag is no longer required.

Tip: alias it for daily use.

```bash
echo 'alias claude-slack="claude --channels plugin:slack@buzzie-ai"' >> ~/.zshrc
```

### 4. Test it

DM the bot in Slack. The message should arrive in your terminal as a
`<channel source="plugin:slack:slack" kind="dm" ...>` event, and Claude can
reply back through the same DM.

To use it in a channel:

1. In Slack, `/invite @claude` to add the bot to the channel.
2. Either `@claude hello` (always forwards), or set a text prefix:

   ```text
   /slack:access prefix add ^!c\b
   ```

   then post `!c what's failing?` in the channel. Claude's reply auto-threads
   to your message.

## Slash commands

- `/slack:configure` — show auth + access status, link a workspace, paste tokens.
- `/slack:access` — manage prefix gates for channel messages.

## Tools exposed to Claude

| Tool   | When available | Purpose |
| ------ | -------------- | ------- |
| `reply` | Channel-gated (only on turns with a `<channel>` event) | Reply to a Slack message. Auto-threads to the inbound `thread_ts`; pass `thread_ts: ""` to break out of a thread. |
| `react` | Channel-gated | React to an inbound message with an emoji (Slack short name without colons, e.g. `white_check_mark`). |
| `send`  | Always-on (intended for autonomous outbound) | Fire an unsolicited message — cron alerts, capital events, autopilot pings. `text` required; `channel_id` defaults to the operator DM if `installerUserId` is set. |

> The `send` tool exists so cron-triggered or otherwise autonomous turns can
> push messages out through the plugin's existing Bolt session, instead of
> spinning up a second client (Slack Socket Mode treats duplicate connections
> on the same auth as a takeover).

## Diagnostics

The channel server tees all diagnostic output to:

```
~/.claude/channels/slack/server.log
```

Tail it to watch the live message flow:

```bash
tail -f ~/.claude/channels/slack/server.log
```

What you'll see when a Slack message arrives:

```
2026-05-07T... [client] connected as @claude (U0BOT) in team T0123
2026-05-07T... [in] kind=dm channel=D0ABC user=U0HUMAN ts=1714... preview="hey"
2026-05-07T... [in] forward kind=dm channel=dm(D0ABC) user=arvind(U0HUMAN)
```

Common drop reasons (each emits its own `[in]` line, or none at all if
silently filtered):

| Reason | Meaning |
| ------ | ------- |
| (no log line at all) | Channel message in a channel where the bot is invited but the text didn't match any configured prefix and didn't `@`-mention the bot. |
| `subtype` | A system event (channel_join, message_changed, etc.) — not a user message. |
| `bot_id` | A message posted by another bot — filtered to avoid loops. |
| `permission verdict IGNORED` | Someone tried to approve a tool prompt with `yes <id>` but isn't the trusted sender (installer / originator of the request). |

The log auto-rotates at 5MB (previous file kept as `server.log.1`). Outbound
`[tool]` and `[send]` lines also land here, so a single `tail -f` shows the
full request/response cycle.

## Develop locally

```bash
git clone https://github.com/Buzzie-AI/slack-plugin
cd slack-plugin
npm install
```

Then in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "slack": {
      "command": "node",
      "args": ["/absolute/path/to/slack-plugin/server.mjs"]
    }
  }
}
```

And start Claude Code with the development flag (custom channels aren't on
the approved allowlist during the research preview):

```bash
claude --dangerously-load-development-channels server:slack
```

## Security model

- **DMs are open.** Anyone in the workspace can DM the bot. By design — Slack
  workspaces are already an authentication boundary. If you want stricter
  control, fork this plugin and add an allowlist (the WhatsApp sibling
  plugin's pattern is a good template).
- **Channels are auto-listened wherever the bot is invited.** Trust = "you
  wouldn't `/invite @claude` to a channel you don't want it watching." Remove
  with `/kick @claude` in Slack.
- **Channel messages need a prefix or `@`-mention.** Plain channel chatter is
  silently dropped.
- **Permission relay scoped to a trusted sender.** Tool-approval verdicts
  (`yes <id>` / `no <id>`) are only honored from the configured
  `installerUserId`, or — if unset — from the same user who triggered the
  request. Workspace members can't spoof approvals.
- **No outbound until linked.** If `~/.slack-cli/auth/tokens.json` is
  missing, the MCP server still connects but tool calls fail with a clear
  message and no message-pushing happens.
- **Tokens live in `~/.slack-cli/auth/tokens.json` at mode 0600.** Don't
  commit this file. Regenerate both tokens in the Slack app settings if a
  transcript leaks.

## State files

| Path | Owned by | Purpose |
|---|---|---|
| `~/.slack-cli/auth/tokens.json` | `/slack:configure` | bot + app tokens; cached `teamId`, `botUserId`, `installerUserId` |
| `~/.claude/channels/slack/access.json` | `/slack:access` | global + per-channel prefix regexes |
| `~/.claude/channels/slack/server.log` | server | rotating log (5MB) |

## How it compares to the official channels

| Plugin    | Auth model              | Storage of creds         |
| --------- | ----------------------- | ------------------------ |
| telegram  | bot token from BotFather | `~/.claude/channels/telegram/.env` |
| discord   | bot token from dev portal | `~/.claude/channels/discord/.env` |
| imessage  | reads `chat.db` directly  | (no creds — macOS native) |
| whatsapp  | linked-device QR/pairing-code | `~/.whatsapp-cli/auth/` (managed by `@buzzie-ai/whatsapp-channel`) |
| **slack** | bot token + app-level token (Socket Mode) | `~/.slack-cli/auth/tokens.json` |

## License

Apache-2.0
