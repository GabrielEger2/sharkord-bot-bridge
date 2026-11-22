/**
 * The wire contract the bridge speaks with a bot. Both shapes are part of the
 * public API: a bot implements one webhook receiver for `TBridgeEvent` and
 * calls `/send` with `TSendRequest`.
 */

/** POSTed to the configured `webhookUrl` for every forwarded message. */
export type TBridgeEvent = {
  /** contract version; bumped on breaking envelope changes */
  v: 1;
  event: "message.created";
  messageId: number;
  channelId: number;
  userId: number;
  userName: string;
  /** Sharkord's plain-text rendering of the message */
  textContent: string;
  /** set when the message is an inline reply */
  replyToMessageId: number | null;
  /** when the bridge forwarded it, ISO 8601 */
  ts: string;
};

/** Body of `POST /plugins/bot-bridge/send`. Exactly one of `html` | `text`. */
export type TSendRequest = {
  /** defaults to the configured channel; any other value is rejected in v1 */
  channelId?: number;
  /** sent as-is (sanitized server-side by Sharkord) */
  html?: string;
  /** escaped, newlines become <br> */
  text?: string;
  /** message id to reply to inline */
  replyTo?: number;
  /** link previews, on unless explicitly false */
  previews?: boolean;
};

export type TSendResponse = { ok: true; messageId: number };

export type THealthResponse = {
  ok: true;
  channelId: number;
  /** false while `webhookUrl` is unset */
  forwarding: boolean;
};
