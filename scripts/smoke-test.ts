// Exercises the whole contract without a Sharkord server: onLoad runs against
// a mocked PluginContext, the registered HTTP handlers are mounted on a real
// node server, and a local webhook receiver stands in for the bot. Run with
// `bun run smoke`.
import assert from "node:assert/strict";
import http, {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { onLoad, onUnload } from "../src/server/index";

type THandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { userId?: number },
) => unknown;

const settingsValues: Record<string, unknown> = {
  webhookUrl: "",
  outboundSecret: "out-secret",
  inboundSecret: "in-secret",
  channelId: 5,
};

const routes = new Map<string, THandler>();
const eventHandlers = new Map<string, (payload: unknown) => unknown>();
const sent: { channelId: number; content: string; options: unknown }[] = [];
const logs: string[] = [];

const ctx = {
  logger: {
    log: (...args: unknown[]) => logs.push(args.join(" ")),
    debug: () => {},
    error: (...args: unknown[]) => logs.push(`ERROR ${args.join(" ")}`),
  },
  settings: {
    register: async () => ({
      get: (key: string) => settingsValues[key],
      set: (key: string, value: unknown) => {
        settingsValues[key] = value;
      },
    }),
  },
  events: {
    on: (event: string, handler: (payload: unknown) => unknown) => {
      eventHandlers.set(event, handler);

      return () => eventHandlers.delete(event);
    },
    off: () => {},
  },
  users: {
    get: async (userId: number) =>
      userId === 2 ? { id: 2, name: "gabriel" } : undefined,
  },
  messages: {
    send: async (channelId: number, content: string, options: unknown) => {
      sent.push({ channelId, content, options });

      return { messageId: 456 };
    },
  },
  http: {
    post: (path: string, handler: THandler) => routes.set(`POST ${path}`, handler),
    get: (path: string, handler: THandler) => routes.set(`GET ${path}`, handler),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

await onLoad(ctx);

// the registered handlers behind a real HTTP server, as Sharkord would mount them
const api = http.createServer((req, res) => {
  const handler = routes.get(`${req.method} ${new URL(req.url!, "http://x").pathname}`);

  if (!handler) {
    res.writeHead(404);
    res.end();

    return;
  }

  Promise.resolve(handler(req, res, {})).catch((error) => {
    res.writeHead(500);
    res.end(String(error));
  });
});

await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiPort = (api.address() as { port: number }).port;

const call = async (
  method: string,
  path: string,
  options: { auth?: string; body?: unknown } = {},
) => {
  const res = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method,
    headers: {
      ...(options.auth ? { authorization: `Bearer ${options.auth}` } : {}),
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });

  return { status: res.status, body: await res.json().catch(() => null) };
};

// ---- inbound: /send and /health ----

assert.equal((await call("POST", "/send", { body: { text: "hi" } })).status, 401);
assert.equal((await call("GET", "/health")).status, 401);

const health = await call("GET", "/health", { auth: "in-secret" });
assert.deepEqual(health.body, { ok: true, channelId: 5, forwarding: false });

const sendText = await call("POST", "/send", {
  auth: "in-secret",
  body: { text: "a <b>\nsecond line" },
});
assert.deepEqual(sendText.body, { ok: true, messageId: 456 });
assert.equal(sent[0]!.channelId, 5);
assert.equal(sent[0]!.content, "<p>a &lt;b&gt;<br>second line</p>");

const sendHtml = await call("POST", "/send", {
  auth: "in-secret",
  body: { html: '<a href="https://x.dev">x</a>', replyTo: 123 },
});
assert.equal(sendHtml.status, 200);
assert.ok(sent[1]!.content.includes('target="_blank"'));
assert.equal(
  (sent[1]!.options as { replyToMessageId?: number }).replyToMessageId,
  123,
);

assert.equal(
  (await call("POST", "/send", { auth: "in-secret", body: { text: "x", html: "<p>x</p>" } })).status,
  400,
);
assert.equal(
  (await call("POST", "/send", { auth: "in-secret", body: {} })).status,
  400,
);
assert.equal(
  (await call("POST", "/send", { auth: "in-secret", body: { text: "x", channelId: 99 } })).status,
  403,
);

// ---- outbound: event forwarding ----

const received: unknown[] = [];
let failFirst = true;

const webhook = http.createServer((req, res) => {
  let body = "";

  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (failFirst) {
      failFirst = false;
      res.writeHead(500);
      res.end();

      return;
    }

    assert.equal(req.headers.authorization, "Bearer out-secret");
    received.push(JSON.parse(body));
    res.writeHead(200);
    res.end();
  });
});

await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
settingsValues.webhookUrl = `http://127.0.0.1:${(webhook.address() as { port: number }).port}/events`;

const emit = (payload: unknown) =>
  Promise.resolve(eventHandlers.get("message:created")!(payload));

// a plugin message and a wrong-channel message are never forwarded
await emit({ messageId: 1, channelId: 5, userId: null, pluginId: "bot-bridge", textContent: "own reply", replyToMessageId: null });
await emit({ messageId: 2, channelId: 9, userId: 2, pluginId: null, textContent: "elsewhere", replyToMessageId: null });
assert.equal(received.length, 0);

// a user message is forwarded — and survives one failed attempt (first retry
// fires after 2 s, so this is the slow part of the test)
await emit({ messageId: 3, channelId: 5, userId: 2, pluginId: null, textContent: "hello bot", replyToMessageId: null });

const event = received[0] as Record<string, unknown>;
assert.equal(received.length, 1);
assert.equal(event.v, 1);
assert.equal(event.event, "message.created");
assert.equal(event.userName, "gabriel");
assert.equal(event.textContent, "hello bot");
assert.ok(typeof event.ts === "string" && !Number.isNaN(Date.parse(event.ts as string)));

onUnload(ctx);
api.close();
webhook.close();

console.log("smoke test passed: auth, send, health, forwarding, loop prevention, retry");
