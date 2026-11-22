# Bot Bridge — a Sharkord plugin

Sharkord has no bot accounts, no incoming webhooks, and no outbound event
push — the plugin SDK is the only door into a server, so every external bot
(LLM agent, bridge, automation) needs the same bespoke plugin written first.
Bot Bridge is that plugin, written once and agent-agnostic: it speaks a small
HTTP contract any bot can implement, and makes the bot behave the way a
Discord bot does. Nothing in it knows what your bot is.

- **@-mentionable everywhere** — the bridge creates a role named after your
  bot (the way Discord gives every bot an integration role), so users call it
  from any channel with a real `@name` mention: autocomplete, highlight and
  all. Replying to one of the bot's messages works too.
- **Events out** — messages that address the bot (or, optionally, every
  message) are POSTed to your bot's webhook URL.
- **API in** — your bot posts to any channel through `/send`, and manages the
  server through `/rpc`: create/edit/delete channels and categories, edit,
  react to and pin messages, list users and roles. Its messages render under
  the plugin's name with a bot badge.

One install = one bot identity. The name and logo on the bot's messages come
from `manifest.json`, so when you install the bridge for a specific bot, set
`name` and `logo` there to the bot's identity (and keep `id` unique per
install). A second bot is a second install. Text messages only for now;
attachments, reactions-as-events and voice are future work.

## Settings

| Key | Meaning |
|---|---|
| Bot name | What users @-mention to call the bot (e.g. `hermes`). A role with this name is created automatically as the mention target. |
| Webhook URL | Where to POST events. Empty = forwarding disabled (the API still works). |
| Forward all messages | Off (default): only messages that @-mention the bot or reply to it are forwarded. On: every user message in every channel, Discord-gateway style — the bot filters. |
| Outbound secret | Sent as `Authorization: Bearer <s>` on every event POST, so your bot can verify the bridge. |
| Inbound secret | Required as `Authorization: Bearer <s>` on `/send`, `/rpc` and `/health`. Routes reject everything until it is set. |

## The contract

Typed in [`src/types.ts`](src/types.ts). All routes live under
`/plugins/bot-bridge/`, bodies are capped at 256 KB.

### Events your bot receives

For each forwarded message (never a plugin's own messages — that is the loop
prevention), the bridge POSTs to your webhook:

```json
{
  "v": 2,
  "event": "message.created",
  "messageId": 123,
  "channelId": 5,
  "channelName": "general",
  "userId": 2,
  "userName": "gabriel",
  "textContent": "@hermes what's on my watchlist?",
  "mentioned": true,
  "replyToMessageId": null,
  "ts": "2026-11-22T14:03:11.000Z"
}
```

`mentioned` is true when the message addresses the bot: an @-mention of the
bot's role, a literal `@<bot name>` in the text, or an inline reply to one of
the bot's messages. With "Forward all messages" off it is always true.

Delivery is **at-least-once, best effort**: a 10 s timeout and two retries
(after 2 s and 10 s), then the event is dropped and logged. Answer `2xx`
quickly and do the work after responding.

### `POST /send`

```sh
curl -X POST https://your-server/plugins/bot-bridge/send \
  -H "Authorization: Bearer $INBOUND_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"channelId": 5, "text": "hello from the bot"}'
```

```json
{ "channelId": 5, "html": "<p>…</p>", "replyTo": 123, "previews": false }
```

- `channelId` is required — the bot can post in any channel.
- Exactly one of `html` | `text`. `text` is escaped and `\n` becomes `<br>`;
  `html` is sent as written (Sharkord sanitizes it) with `target="_blank"`
  added to bare anchors, since a target-less anchor navigates the SPA away.
- `replyTo` makes the message an inline reply to that message id.
- `previews` (default `true`) controls link cards.
- Response: `{"ok": true, "messageId": 456}`.

### `POST /rpc`

Everything beyond sending — a thin allowlisted façade over the plugin SDK:

```sh
curl -X POST https://your-server/plugins/bot-bridge/rpc \
  -H "Authorization: Bearer $INBOUND_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"op": "channels.create", "args": {"name": "job-digest", "categoryId": 1}}'
```

Response: `{"ok": true, "result": …}` with whatever the SDK call returned
(`null` for void calls). An unknown `op` answers 400 and lists the valid ops;
a bad argument answers 400 with a message written to be fed back to a bot.

| Op | Args |
|---|---|
| `messages.get` | `messageId` |
| `messages.list` | `channelId`, `limit?`, `before?` (newest first, `before` pages backwards) |
| `messages.edit` | `messageId`, `html`\|`text`, `previews?` |
| `messages.delete` | `messageId` |
| `messages.react` / `messages.unreact` | `messageId`, `emoji` |
| `messages.pin` / `messages.unpin` | `messageId` |
| `channels.list` | — |
| `channels.get` | `channelId` |
| `channels.create` | `name`, `categoryId`, `type?` (`TEXT`/`VOICE`), `private?` |
| `channels.update` | `channelId`, `name?`, `topic?`, `private?` |
| `channels.delete` | `channelId` |
| `channels.reorder` | `categoryId`, `channelIds` |
| `categories.list` / `categories.get` | — / `categoryId` |
| `categories.create` / `categories.update` / `categories.delete` | `name` / `categoryId`, `name` / `categoryId` |
| `users.list` / `users.get` | — / `userId` |
| `roles.list` | — |

Moderation (bans, kicks, role assignment) is deliberately not exposed.

### `GET /health`

```sh
curl -H "Authorization: Bearer $INBOUND_SECRET" \
  https://your-server/plugins/bot-bridge/health
```

`{"ok": true, "botName": "hermes", "roleId": 7, "forwarding": true, "forwardAll": false}`
— `roleId` is `null` while the mention role could not be created (plain-text
`@name` still works), `forwarding` is `false` while no webhook URL is set.
Auth required, since the response leaks config shape.

## Security notes

- The inbound secret grants **server-wide** bot powers: posting anywhere,
  channel management, message editing. Treat it like an admin credential and
  rotate it from the plugin settings if it leaks. Kill switch: disable the
  plugin.
- The bridge never forwards plugin-authored messages, so two bridged bots
  cannot feed each other.

## Trying it without a bot

1. Enable the plugin, set the bot name and both secrets, leave the webhook
   URL empty → the `curl /send` above lands in the channel you point it at; a
   wrong bearer gets 401; `@<bot name>` autocompletes in the message box.
2. Point the webhook URL at `nc -l 8650` or a request bin → @-mentioning the
   bot anywhere produces one event POST; unaddressed chatter and the bridge's
   own replies produce none (flip "Forward all messages" to get everything).
3. Set an unreachable webhook URL → two retries in the plugin log, then a
   drop; Sharkord stays healthy.

## Developing

The SDK and builder are not on npm. This clones Sharkord and the plugin
builder into `.repos/` and `bun link`s them:

```bash
bun run setup
```

Point `SHARKORD_PLUGINS_PATH` in `.env` at your server's plugins folder (see
`.env.example`), then:

```bash
bun run build
```

Enable plugins in the server settings, then enable this one. Restart the
server to pick up a rebuild. `bun run smoke` exercises the whole contract —
addressing, forwarding, retries, `/send`, `/rpc`, auth — against a mocked
plugin context, no server needed.

## Publishing

Bump `version` in `package.json`, set `GITHUB_TOKEN` in `.env`, then:

```bash
bun run publish
```

This builds, creates the GitHub release, and opens a PR against the
[Sharkord plugin registry](https://github.com/Sharkord/plugins).

## Known limits

- No typing indicator — the plugin SDK has none. If your bot is slow, send a
  fast ack message first.
- No replay: an event dropped after the retries is gone. A cursor endpoint
  (`GET /events?cursor=`) for bots that cannot expose a port is sketched as
  future work.
- The bot's display name on messages is the manifest `name`, not the Bot name
  setting — the SDK attributes messages to the plugin. Keep the two aligned
  when installing.
- `sdkVersion` in `manifest.json` must match the server exactly or the plugin
  won't load; the SDK is explicitly still moving.
