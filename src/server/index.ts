import {
  ChannelType,
  type PluginContext,
  type TUpgradeInfo,
  type UnloadPluginContext,
  type UpgradePluginContext,
} from "@sharkord/plugin-sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TBridgeEvent, TRpcRequest, TSendRequest } from "../types";

const MAX_BODY = 262144;

// the color Discord gives bot integration roles — a familiar "this is a bot"
const BOT_ROLE_COLOR = "#5865f2";

// delivery: at-least-once, best effort — one try plus two retries, then drop.
// Chat messages are not bank transfers; a bot that needs replay can ask the
// user to repeat.
const DELIVERY_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [2_000, 10_000];

// a leaked timer survives a reload and fires against the next load, so every
// retry sleep is tracked and released in onUnload
const pendingSleeps = new Set<{ timer: Timer; resolve: () => void }>();
let unloaded = false;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const entry = {
      timer: setTimeout(() => {
        pendingSleeps.delete(entry);
        resolve();
      }, ms),
      resolve,
    };

    pendingSleeps.add(entry);
  });

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }

      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Sharkord only adds target="_blank" to URLs it linkifies itself; anchors that
// arrive already formed keep their attributes, and a target-less anchor
// navigates the SPA tab away (the client reloads from scratch on return).
const blankTargets = (html: string) =>
  html.replace(
    /<a\b(?![^>]*\btarget=)/gi,
    '<a target="_blank" rel="noopener noreferrer" ',
  );

// role mentions arrive in the content HTML the way the editor writes them:
// <span data-type="role-mention" data-role-id="N">. Attribute order is not
// guaranteed, so each span tag is checked for both attributes separately,
// same as Sharkord's own has-mention helper.
const SPAN_TAG_PATTERN = /<span\b[^>]*>/g;
const DATA_TYPE_PATTERN = /\bdata-type="role-mention"/;
const ROLE_ID_PATTERN = /\bdata-role-id="(\d+)"/;

const mentionsRole = (content: string, roleId: number): boolean => {
  for (const [tag] of content.matchAll(SPAN_TAG_PATTERN)) {
    if (!DATA_TYPE_PATTERN.test(tag)) continue;

    const roleIdMatch = tag.match(ROLE_ID_PATTERN);

    if (roleIdMatch && Number(roleIdMatch[1]) === roleId) return true;
  }

  return false;
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

// loose named-argument validation for /rpc — the callers are bots, so the
// errors are written to be fed back to one
const num = (args: Record<string, unknown>, field: string): number => {
  const value = Number(args[field]);

  if (!Number.isFinite(value)) {
    throw new RpcArgError(`"${field}" must be a number`);
  }

  return value;
};

const str = (args: Record<string, unknown>, field: string): string => {
  const value = args[field];

  if (typeof value !== "string" || value === "") {
    throw new RpcArgError(`"${field}" must be a non-empty string`);
  }

  return value;
};

class RpcArgError extends Error {}

/** exactly one of html | text, html with the anchor fix, text escaped */
const contentFrom = (payload: { html?: unknown; text?: unknown }): string => {
  const hasHtml = typeof payload.html === "string" && payload.html !== "";
  const hasText = typeof payload.text === "string" && payload.text !== "";

  if (hasHtml === hasText) {
    throw new RpcArgError(
      'send exactly one of {"html": "..."} or {"text": "..."}',
    );
  }

  return hasHtml
    ? blankTargets(payload.html as string)
    : `<p>${escapeHtml(payload.text as string).replace(/\n/g, "<br>")}</p>`;
};

const onLoad = async (ctx: PluginContext) => {
  // a re-enable can reuse the evaluated module, so the unload flag resets here
  unloaded = false;

  const settings = await ctx.settings.register([
    {
      key: "botName",
      name: "Bot name",
      description:
        "The name users @-mention to call the bot. A role with this name is created as the mention target, the way Discord gives every bot an integration role.",
      type: "string",
      defaultValue: "bot",
    },
    {
      key: "webhookUrl",
      name: "Webhook URL",
      description:
        "Where message events are POSTed. Leave empty to disable forwarding (the send/rpc API still works).",
      type: "string",
      defaultValue: "",
    },
    {
      key: "forwardAll",
      name: "Forward all messages",
      description:
        "Forward every user message in every channel (the bot filters). Off = only messages that @-mention the bot or reply to it.",
      type: "boolean",
      defaultValue: false,
    },
    {
      key: "outboundSecret",
      name: "Outbound secret",
      description:
        'Sent as "Authorization: Bearer <secret>" on every event POST, so the bot can verify us.',
      type: "secret",
      defaultValue: "",
    },
    {
      key: "inboundSecret",
      name: "Inbound secret",
      description:
        'Callers of /send and /rpc must present this as "Authorization: Bearer <secret>". Routes reject everything until it is set.',
      type: "secret",
      defaultValue: "",
    },
  ] as const);

  // ---- the bot's mention role ----

  let botRoleId: number | null = null;

  const ensureBotRole = async () => {
    const name = String(settings.get("botName")).trim();

    if (!name) {
      botRoleId = null;

      return;
    }

    try {
      const roles = await ctx.roles.list();
      const existing = roles.find(
        (role) => role.name.toLowerCase() === name.toLowerCase(),
      );

      botRoleId =
        existing?.id ??
        (await ctx.roles.create({ name, color: BOT_ROLE_COLOR })).id;
    } catch (error) {
      // a full role list (100) or similar — @botName in plain text still works
      botRoleId = null;
      ctx.logger.error(`could not ensure the bot role "${name}": ${error}`);
    }
  };

  await ensureBotRole();

  ctx.events.on("setting:set", ({ key }) => {
    if (key === "botName") void ensureBotRole();
  });

  // ---- caches (per load; invalidated by their update events) ----

  const userNames = new Map<number, string>();
  const channelNames = new Map<number, string>();

  const userName = async (userId: number) => {
    const cached = userNames.get(userId);

    if (cached) return cached;

    const user = await ctx.users.get(userId);
    const name = user?.name ?? `user-${userId}`;

    userNames.set(userId, name);

    return name;
  };

  const channelName = async (channelId: number) => {
    const cached = channelNames.get(channelId);

    if (cached) return cached;

    const channel = await ctx.channels.get(channelId);
    const name = channel?.name ?? `channel-${channelId}`;

    channelNames.set(channelId, name);

    return name;
  };

  ctx.events.on("user:updated", ({ userId }) => {
    userNames.delete(userId);
  });
  ctx.events.on("channel:updated", ({ channelId }) => {
    channelNames.delete(channelId);
  });
  ctx.events.on("channel:deleted", ({ channelId }) => {
    channelNames.delete(channelId);
  });

  // ---- outbound: event forwarding ----

  const deliver = async (url: string, secret: string, event: TBridgeEvent) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(secret ? { authorization: `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });

        if (res.ok) return;

        throw new Error(`webhook answered ${res.status}`);
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];

        if (delay === undefined) {
          ctx.logger.log(
            `dropped event for message ${event.messageId} after ${attempt + 1} attempts: ${error}`,
          );

          return;
        }

        await sleep(delay);

        if (unloaded) return;
      }
    }
  };

  /** an @-mention of the bot's role, a literal @name, or a reply to the bot */
  const addressesBot = async (message: {
    content: string;
    textContent: string;
    replyToMessageId: number | null;
  }): Promise<boolean> => {
    if (botRoleId !== null && mentionsRole(message.content, botRoleId)) {
      return true;
    }

    const name = String(settings.get("botName")).trim();

    if (
      name &&
      new RegExp(`(^|\\W)@${escapeRegExp(name)}($|\\W)`, "i").test(
        message.textContent,
      )
    ) {
      return true;
    }

    if (message.replyToMessageId !== null) {
      const repliedTo = await ctx.messages.get(message.replyToMessageId);

      if (repliedTo?.pluginId === ctx.pluginId) return true;
    }

    return false;
  };

  ctx.events.on("message:created", async (message) => {
    const webhookUrl = settings.get("webhookUrl");

    if (!webhookUrl) return;
    // loop prevention: never forward any plugin's messages, including our own
    if (message.pluginId !== null) return;
    if (message.userId === null) return;

    const mentioned = await addressesBot(message);

    if (!mentioned && !settings.get("forwardAll")) return;

    await deliver(webhookUrl, String(settings.get("outboundSecret")), {
      v: 2,
      event: "message.created",
      messageId: message.messageId,
      channelId: message.channelId,
      channelName: await channelName(message.channelId),
      userId: message.userId,
      userName: await userName(message.userId),
      textContent: message.textContent,
      mentioned,
      replyToMessageId: message.replyToMessageId,
      ts: new Date().toISOString(),
    });
  });

  // ---- inbound: HTTP API ----

  const authed = (req: IncomingMessage) => {
    const secret = String(settings.get("inboundSecret"));

    return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
  };

  // plugin routes are public by default in the SDK, so auth is in-handler
  ctx.http.post("/send", async (req, res) => {
    if (!authed(req)) {
      return json(res, 401, { error: "bad or missing secret" });
    }

    let payload: TSendRequest;

    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "body must be JSON under 256 KB" });
    }

    const channelId = Number(payload.channelId);

    if (!Number.isFinite(channelId) || channelId <= 0) {
      return json(res, 400, { error: '"channelId" is required' });
    }

    let content: string;

    try {
      content = contentFrom(payload);
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }

    const { messageId } = await ctx.messages.send(channelId, content, {
      previews: payload.previews !== false,
      ...(typeof payload.replyTo === "number"
        ? { replyToMessageId: payload.replyTo }
        : {}),
    });

    return json(res, 200, { ok: true, messageId });
  });

  // everything beyond sending: a thin allowlisted façade over the plugin SDK.
  // Moderation (bans, kicks, role assignment) is deliberately not exposed.
  const rpcOps: Record<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  > = {
    "messages.get": (a) => ctx.messages.get(num(a, "messageId")),
    "messages.list": (a) =>
      ctx.messages.list({
        channelId: num(a, "channelId"),
        ...(a.limit !== undefined ? { limit: num(a, "limit") } : {}),
        ...(a.before !== undefined ? { before: num(a, "before") } : {}),
      }),
    "messages.edit": (a) =>
      ctx.messages.edit(num(a, "messageId"), contentFrom(a), {
        previews: a.previews !== false,
      }),
    "messages.delete": (a) => ctx.messages.delete(num(a, "messageId")),
    "messages.react": (a) =>
      ctx.messages.react(num(a, "messageId"), str(a, "emoji")),
    "messages.unreact": (a) =>
      ctx.messages.unreact(num(a, "messageId"), str(a, "emoji")),
    "messages.pin": (a) => ctx.messages.pin(num(a, "messageId")),
    "messages.unpin": (a) => ctx.messages.unpin(num(a, "messageId")),

    "channels.list": () => ctx.channels.list(),
    "channels.get": (a) => ctx.channels.get(num(a, "channelId")),
    "channels.create": (a) =>
      ctx.channels.create({
        name: str(a, "name"),
        categoryId: num(a, "categoryId"),
        type: a.type === "VOICE" ? ChannelType.VOICE : ChannelType.TEXT,
        ...(a.private !== undefined ? { private: Boolean(a.private) } : {}),
      }),
    "channels.update": (a) =>
      ctx.channels.update(num(a, "channelId"), {
        ...(a.name !== undefined ? { name: str(a, "name") } : {}),
        ...(a.topic !== undefined
          ? { topic: a.topic === null ? null : str(a, "topic") }
          : {}),
        ...(a.private !== undefined ? { private: Boolean(a.private) } : {}),
      }),
    "channels.delete": (a) => ctx.channels.delete(num(a, "channelId")),
    "channels.reorder": (a) => {
      const channelIds = a.channelIds;

      if (
        !Array.isArray(channelIds) ||
        channelIds.some((id) => !Number.isFinite(Number(id)))
      ) {
        throw new RpcArgError('"channelIds" must be an array of numbers');
      }

      return ctx.channels.reorder(num(a, "categoryId"), channelIds.map(Number));
    },

    "categories.list": () => ctx.categories.list(),
    "categories.get": (a) => ctx.categories.get(num(a, "categoryId")),
    "categories.create": (a) => ctx.categories.create(str(a, "name")),
    "categories.update": (a) =>
      ctx.categories.update(num(a, "categoryId"), str(a, "name")),
    "categories.delete": (a) => ctx.categories.delete(num(a, "categoryId")),

    "users.list": () => ctx.users.list(),
    "users.get": (a) => ctx.users.get(num(a, "userId")),
    "roles.list": () => ctx.roles.list(),
  };

  ctx.http.post("/rpc", async (req, res) => {
    if (!authed(req)) {
      return json(res, 401, { error: "bad or missing secret" });
    }

    let payload: TRpcRequest;

    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "body must be JSON under 256 KB" });
    }

    const op = rpcOps[String(payload.op)];

    if (!op) {
      return json(res, 400, {
        error: `unknown op "${payload.op}"`,
        ops: Object.keys(rpcOps),
      });
    }

    try {
      const result = (await op(payload.args ?? {})) ?? null;

      return json(res, 200, { ok: true, result });
    } catch (error) {
      if (error instanceof RpcArgError) {
        return json(res, 400, { error: error.message });
      }

      ctx.logger.error(`rpc ${payload.op} failed: ${error}`);

      return json(res, 500, { error: String(error) });
    }
  });

  // auth required: the response leaks config shape
  ctx.http.get("/health", (req, res) => {
    if (!authed(req)) {
      return json(res, 401, { error: "bad or missing secret" });
    }

    return json(res, 200, {
      ok: true,
      botName: String(settings.get("botName")),
      roleId: botRoleId,
      forwarding: Boolean(settings.get("webhookUrl")),
      forwardAll: Boolean(settings.get("forwardAll")),
    });
  });

  ctx.logger.log("Bot Proxy loaded");
};

const onUnload = (ctx: UnloadPluginContext) => {
  unloaded = true;

  for (const { timer, resolve } of pendingSleeps) {
    clearTimeout(timer);
    resolve();
  }

  pendingSleeps.clear();

  ctx.logger.log("Bot Proxy unloaded");
};

const onUpgrade = (ctx: UpgradePluginContext, info: TUpgradeInfo) => {
  ctx.logger.log(`Upgraded from ${info.previousVersion} to ${info.version}`);
};

export { onLoad, onUnload, onUpgrade };
