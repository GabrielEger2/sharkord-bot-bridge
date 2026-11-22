/**
 * The wire contract the bridge speaks with a bot. These shapes are the public
 * API: a bot implements one webhook receiver for `TBridgeEvent` and calls
 * `/send` and `/rpc` with the request types below.
 */

/** POSTed to the configured `webhookUrl` for every forwarded message. */
export type TBridgeEvent = {
  /** contract version; bumped on breaking envelope changes */
  v: 2;
  event: "message.created";
  messageId: number;
  channelId: number;
  channelName: string;
  userId: number;
  userName: string;
  /** Sharkord's plain-text rendering of the message */
  textContent: string;
  /**
   * true when the message addresses the bot: an @-mention of the bot's role,
   * a literal "@<botName>" in the text, or an inline reply to one of the
   * bot's own messages. With "Forward all messages" off, only addressed
   * messages are forwarded, so this is always true there.
   */
  mentioned: boolean;
  /** set when the message is an inline reply */
  replyToMessageId: number | null;
  /** when the bridge forwarded it, ISO 8601 */
  ts: string;
};

/** Body of `POST /plugins/bot-proxy/send`. Exactly one of `html` | `text`. */
export type TSendRequest = {
  /** the channel to post in — any channel on the server */
  channelId: number;
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

/**
 * Body of `POST /plugins/bot-proxy/rpc` — everything beyond sending.
 * `op` names an allowlisted SDK call (see README for the full list, e.g.
 * "channels.create", "messages.react"); `args` are its named arguments.
 */
export type TRpcRequest = {
  op: string;
  args?: Record<string, unknown>;
};

export type TRpcResponse = { ok: true; result: unknown };

export type THealthResponse = {
  ok: true;
  botName: string;
  /** the bot's mention role, null while it could not be created */
  roleId: number | null;
  /** false while `webhookUrl` is unset */
  forwarding: boolean;
  forwardAll: boolean;
};
