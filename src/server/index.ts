import type {
  PluginContext,
  TUpgradeInfo,
  UnloadPluginContext,
  UpgradePluginContext,
} from "@sharkord/plugin-sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TBridgeEvent, TSendRequest } from "../types";

const MAX_BODY = 262144;

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

// Sharkord only adds target="_blank" to URLs it linkifies itself; anchors that
// arrive already formed keep their attributes, and a target-less anchor
// navigates the SPA tab away (the client reloads from scratch on return).
const blankTargets = (html: string) =>
  html.replace(
    /<a\b(?![^>]*\btarget=)/gi,
    '<a target="_blank" rel="noopener noreferrer" ',
  );

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const onLoad = async (ctx: PluginContext) => {
  // a re-enable can reuse the evaluated module, so the unload flag resets here
  unloaded = false;

  const settings = await ctx.settings.register([
    {
      key: "webhookUrl",
      name: "Webhook URL",
      description:
        "Where message events are POSTed. Leave empty to disable forwarding (the send API still works).",
      type: "string",
      defaultValue: "",
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
        'Callers of /send must present this as "Authorization: Bearer <secret>". Routes reject everything until it is set.',
      type: "secret",
      defaultValue: "",
    },
    {
      key: "channelId",
      name: "Bot channel",
      description:
        "The channel this bot lives in: its messages are forwarded, and replies land here.",
      type: "channel",
      defaultValue: 0,
    },
  ] as const);

  const names = new Map<number, string>();

  const userName = async (userId: number) => {
    const cached = names.get(userId);

    if (cached) return cached;

    const user = await ctx.users.get(userId);
    const name = user?.name ?? `user-${userId}`;

    names.set(userId, name);

    return name;
  };

  ctx.events.on("user:updated", ({ userId }) => {
    names.delete(userId);
  });

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

  ctx.events.on("message:created", async (message) => {
    const webhookUrl = settings.get("webhookUrl");
    const channelId = Number(settings.get("channelId"));

    if (!webhookUrl || !channelId) return;
    if (message.channelId !== channelId) return;
    // loop prevention: never forward any plugin's messages, including our own
    if (message.pluginId !== null) return;
    if (message.userId === null) return;

    await deliver(webhookUrl, String(settings.get("outboundSecret")), {
      v: 1,
      event: "message.created",
      messageId: message.messageId,
      channelId: message.channelId,
      userId: message.userId,
      userName: await userName(message.userId),
      textContent: message.textContent,
      replyToMessageId: message.replyToMessageId,
      ts: new Date().toISOString(),
    });
  });

  const authed = (req: IncomingMessage) => {
    const secret = String(settings.get("inboundSecret"));

    return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
  };

  // plugin routes are public by default in the SDK, so auth is in-handler
  ctx.http.post("/send", async (req, res) => {
    if (!authed(req)) {
      return json(res, 401, { error: "bad or missing secret" });
    }

    const configuredChannelId = Number(settings.get("channelId"));

    if (!configuredChannelId) {
      return json(res, 503, { error: "no channel configured" });
    }

    let payload: TSendRequest;

    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "body must be JSON under 256 KB" });
    }

    // explicit channelId must be the configured one: keeps a leaked secret
    // from posting anywhere else on the server
    if (
      payload.channelId !== undefined &&
      Number(payload.channelId) !== configuredChannelId
    ) {
      return json(res, 403, {
        error: `channelId must be the configured channel (${configuredChannelId})`,
      });
    }

    const hasHtml = typeof payload.html === "string" && payload.html !== "";
    const hasText = typeof payload.text === "string" && payload.text !== "";

    if (hasHtml === hasText) {
      return json(res, 400, {
        error: 'send exactly one of {"html": "..."} or {"text": "..."}',
      });
    }

    const content = hasHtml
      ? blankTargets(payload.html as string)
      : `<p>${escapeHtml(payload.text as string).replace(/\n/g, "<br>")}</p>`;

    const { messageId } = await ctx.messages.send(configuredChannelId, content, {
      previews: payload.previews !== false,
      ...(typeof payload.replyTo === "number"
        ? { replyToMessageId: payload.replyTo }
        : {}),
    });

    return json(res, 200, { ok: true, messageId });
  });

  // auth required: the response leaks config shape
  ctx.http.get("/health", (req, res) => {
    if (!authed(req)) {
      return json(res, 401, { error: "bad or missing secret" });
    }

    return json(res, 200, {
      ok: true,
      channelId: Number(settings.get("channelId")),
      forwarding: Boolean(settings.get("webhookUrl")),
    });
  });

  ctx.logger.log("Bot Bridge loaded");
};

const onUnload = (ctx: UnloadPluginContext) => {
  unloaded = true;

  for (const { timer, resolve } of pendingSleeps) {
    clearTimeout(timer);
    resolve();
  }

  pendingSleeps.clear();

  ctx.logger.log("Bot Bridge unloaded");
};

const onUpgrade = (ctx: UpgradePluginContext, info: TUpgradeInfo) => {
  ctx.logger.log(`Upgraded from ${info.previousVersion} to ${info.version}`);
};

export { onLoad, onUnload, onUpgrade };
