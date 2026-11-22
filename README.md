# Bot Bridge — a Sharkord plugin

Sharkord has no bot accounts, no incoming webhooks, and no outbound event
push — the plugin SDK is the only door into a server, so every external bot
(LLM agent, bridge, automation) needs the same bespoke plugin written first.
Bot Bridge is that plugin, written once and agent-agnostic: it speaks a small
HTTP contract any bot can implement. Nothing in it knows what your bot is.

- **Outbound** — messages written in one configured channel are POSTed to your
  bot's webhook URL.
- **Inbound** — your bot posts replies through an authenticated `/send` API.
  They render under the plugin's name with a bot badge.

One install = one bot identity in one channel. A second bot is a second
install under a different plugin id. Text messages only for now; reactions,
edits, deletes and voice events are future work.

## Settings

| Key | Meaning |
|---|---|
| Webhook URL | Where to POST events. Empty = forwarding disabled (send API still works). |
| Outbound secret | Sent as `Authorization: Bearer <s>` on every event POST, so your bot can verify the bridge. |
| Inbound secret | Required as `Authorization: Bearer <s>` on `/send` and `/health`. Routes reject everything until it is set. |
| Bot channel | The channel the bot lives in — both the forwarding source and the send target. |

## The contract

Typed in [`src/types.ts`](src/types.ts). All routes live under
`/plugins/bot-bridge/`, bodies are capped at 256 KB.

### Events your bot receives

On every user message in the configured channel (never a plugin's own
messages — that is the loop prevention), the bridge POSTs to your webhook:

```json
{
  "v": 1,
  "event": "message.created",
  "messageId": 123,
  "channelId": 5,
  "userId": 2,
  "userName": "gabriel",
  "textContent": "bot, what's on my watchlist?",
  "replyToMessageId": null,
  "ts": "2026-11-22T14:03:11.000Z"
}
```

Delivery is **at-least-once, best effort**: a 10 s timeout and two retries
(after 2 s and 10 s), then the event is dropped and logged. Answer `2xx`
quickly and do the work after responding. The bridge forwards everything in
its channel with no command parsing — deciding what to answer is the bot's
job.

### `POST /send`

```sh
curl -X POST https://your-server/plugins/bot-bridge/send \
  -H "Authorization: Bearer $INBOUND_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"text": "hello from the bot"}'
```

```json
{ "channelId": 5, "html": "<p>…</p>", "replyTo": 123, "previews": false }
```

- Exactly one of `html` | `text`. `text` is escaped and `\n` becomes `<br>`;
  `html` is sent as written (Sharkord sanitizes it) with `target="_blank"`
  added to bare anchors, since a target-less anchor navigates the SPA away.
- `channelId` is optional and defaults to the configured channel. Any other
  value is rejected, so a leaked secret cannot post elsewhere.
- `replyTo` makes the message an inline reply to that message id.
- `previews` (default `true`) controls link cards.
- Response: `{"ok": true, "messageId": 456}`.

### `GET /health`

```sh
curl -H "Authorization: Bearer $INBOUND_SECRET" \
  https://your-server/plugins/bot-bridge/health
```

`{"ok": true, "channelId": 5, "forwarding": true}` — `forwarding` is `false`
while no webhook URL is set. Auth required, since the response leaks config
shape.

## Trying it without a bot

1. Enable the plugin, set both secrets and the channel, leave the webhook URL
   empty → the `curl /send` above lands in the channel; a wrong bearer gets
   401.
2. Point the webhook URL at `nc -l 8650` or a request bin → typing in the
   channel produces one event POST; the bridge's own replies produce none.
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
server to pick up a rebuild.

## Publishing

Bump `version` in `package.json`, set `GITHUB_TOKEN` in `.env`, then:

```bash
bun run publish
```

This builds, creates the GitHub release, and opens a PR against the
[Sharkord plugin registry](https://github.com/Sharkord/plugins).

## Known limits

- One channel per install; multi-channel would be a settings change, not an
  architecture change, and may come later.
- No typing indicator — the plugin SDK has none. If your bot is slow, send a
  fast ack message first.
- No replay: an event dropped after the retries is gone. A cursor endpoint
  (`GET /events?cursor=`) for bots that cannot expose a port is sketched as
  future work.
- `sdkVersion` in `manifest.json` must match the server exactly or the plugin
  won't load; the SDK is explicitly still moving.
