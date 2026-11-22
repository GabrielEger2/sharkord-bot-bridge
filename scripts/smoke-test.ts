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
  botName: "hermes",
  webhookUrl: "",
  forwardAll: false,
  outboundSecret: "out-secret",
  inboundSecret: "in-secret",
};

const routes = new Map<string, THandler>();
const eventHandlers = new Map<string, (payload: unknown) => unknown>();
const sent: { channelId: number; content: string; options: unknown }[] = [];
const createdRoles: { name: string; color?: string }[] = [];
const createdChannels: unknown[] = [];
const logs: string[] = [];

const ctx = {
  pluginId: "bot-bridge",
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
  roles: {
    list: async () => [{ id: 1, name: "admin" }],
    create: async (input: { name: string; color?: string }) => {
      createdRoles.push(input);

      return { id: 7, name: input.name };
    },
  },
  users: {
    get: async (userId: number) =>
      userId === 2 ? { id: 2, name: "gabriel" } : undefined,
    list: async () => [{ id: 2, name: "gabriel" }],
  },
  channels: {
    get: async (channelId: number) =>
      channelId === 5 ? { id: 5, name: "general" } : undefined,
    list: async () => [{ id: 5, name: "general" }],
    create: async (input: unknown) => {
      createdChannels.push(input);

      return { id: 11, ...(input as object) };
    },
    update: async () => {},
    delete: async () => {},
    reorder: async () => {},
  },
  categories: {
    list: async () => [{ id: 1, name: "Main" }],
    get: async () => ({ id: 1, name: "Main" }),
    create: async (name: string) => ({ id: 2, name }),
    update: async () => {},
    delete: async () => {},
  },
  messages: {
    send: async (channelId: number, content: string, options: unknown) => {
      sent.push({ channelId, content, options });

      return { messageId: 456 };
    },
    // message 456 is "ours" — a reply to it addresses the bot
    get: async (messageId: number) =>
      messageId === 456
        ? { id: 456, pluginId: "bot-bridge" }
        : { id: messageId, pluginId: null },
    edit: async () => {},
    delete: async () => {},
    react: async () => {},
    unreact: async () => {},
    pin: async () => {},
    unpin: async () => {},
    list: async () => [],
  },
  http: {
    post: (path: string, handler: THandler) => routes.set(`POST ${path}`, handler),
    get: (path: string, handler: THandler) => routes.set(`GET ${path}`, handler),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

await onLoad(ctx);

// ---- bot role bootstrap ----

assert.deepEqual(createdRoles, [{ name: "hermes", color: "#5865f2" }]);

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

  return {
    status: res.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (await res.json().catch(() => null)) as any,
  };
};

// ---- inbound: /send, /rpc and /health ----

assert.equal((await call("POST", "/send", { body: { channelId: 5, text: "hi" } })).status, 401);
assert.equal((await call("GET", "/health")).status, 401);

const health = await call("GET", "/health", { auth: "in-secret" });
assert.deepEqual(health.body, {
  ok: true,
  botName: "hermes",
  roleId: 7,
  forwarding: false,
  forwardAll: false,
});

// channelId is required, any channel is allowed
assert.equal(
  (await call("POST", "/send", { auth: "in-secret", body: { text: "x" } })).status,
  400,
);

const sendText = await call("POST", "/send", {
  auth: "in-secret",
  body: { channelId: 9, text: "a <b>\nsecond line" },
});
assert.deepEqual(sendText.body, { ok: true, messageId: 456 });
assert.equal(sent[0]!.channelId, 9);
assert.equal(sent[0]!.content, "<p>a &lt;b&gt;<br>second line</p>");

const sendHtml = await call("POST", "/send", {
  auth: "in-secret",
  body: { channelId: 5, html: '<a href="https://x.dev">x</a>', replyTo: 123 },
});
assert.equal(sendHtml.status, 200);
assert.ok(sent[1]!.content.includes('target="_blank"'));
assert.equal(
  (sent[1]!.options as { replyToMessageId?: number }).replyToMessageId,
  123,
);

assert.equal(
  (await call("POST", "/send", { auth: "in-secret", body: { channelId: 5, text: "x", html: "<p>x</p>" } })).status,
  400,
);

// rpc: happy path, validation, unknown op
const rpcCreate = await call("POST", "/rpc", {
  auth: "in-secret",
  body: { op: "channels.create", args: { name: "jobs", categoryId: 1 } },
});
assert.equal(rpcCreate.status, 200);
assert.equal((rpcCreate.body.result as { id: number }).id, 11);
assert.equal((createdChannels[0] as { type: string }).type, "TEXT");

const rpcList = await call("POST", "/rpc", {
  auth: "in-secret",
  body: { op: "channels.list" },
});
assert.deepEqual(rpcList.body.result, [{ id: 5, name: "general" }]);

assert.equal(
  (await call("POST", "/rpc", { auth: "in-secret", body: { op: "messages.react", args: { messageId: 1 } } })).status,
  400,
);
const unknown = await call("POST", "/rpc", {
  auth: "in-secret",
  body: { op: "users.ban", args: { userId: 2 } },
});
assert.equal(unknown.status, 400);
assert.ok((unknown.body.ops as string[]).includes("channels.create"));
assert.equal((await call("POST", "/rpc", { body: { op: "channels.list" } })).status, 401);

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

const emit = (payload: Record<string, unknown>) =>
  Promise.resolve(
    eventHandlers.get("message:created")!({
      content: "",
      replyToMessageId: null,
      pluginId: null,
      userId: 2,
      channelId: 5,
      textContent: "",
      ...payload,
    }),
  );

// never forwarded: a plugin's message, and (with forwardAll off) a message
// that does not address the bot
await emit({ messageId: 1, pluginId: "bot-bridge", userId: null, textContent: "@hermes own reply" });
await emit({ messageId: 2, textContent: "just chatting" });
assert.equal(received.length, 0);

// addressed by plain-text @name — survives one failed webhook attempt (the
// first retry fires after 2 s, so this is the slow part of the test)
await emit({ messageId: 3, textContent: "@hermes hello bot" });

const event = received[0] as Record<string, unknown>;
assert.equal(received.length, 1);
assert.equal(event.v, 2);
assert.equal(event.mentioned, true);
assert.equal(event.userName, "gabriel");
assert.equal(event.channelName, "general");
assert.ok(typeof event.ts === "string" && !Number.isNaN(Date.parse(event.ts as string)));

// addressed by role mention (attribute order reversed on purpose)
await emit({
  messageId: 4,
  textContent: "hey can you make a channel",
  content: '<p><span data-role-id="7" data-type="role-mention">@hermes</span> hey</p>',
});
assert.equal(received.length, 2);

// a mention of some OTHER role is not the bot
await emit({
  messageId: 5,
  textContent: "hey admins",
  content: '<p><span data-type="role-mention" data-role-id="1">@admin</span> hey</p>',
});
assert.equal(received.length, 2);

// addressed by replying to one of the bot's messages
await emit({ messageId: 6, textContent: "yes do that", replyToMessageId: 456 });
assert.equal(received.length, 3);

// a reply to a normal user message is not the bot
await emit({ messageId: 7, textContent: "lol", replyToMessageId: 123 });
assert.equal(received.length, 3);

// forwardAll: everything flows, mentioned flags the addressed ones
settingsValues.forwardAll = true;
await emit({ messageId: 8, textContent: "just chatting again" });
assert.equal(received.length, 4);
assert.equal((received[3] as { mentioned: boolean }).mentioned, false);

onUnload(ctx);
api.close();
webhook.close();

console.log(
  "smoke test passed: role bootstrap, auth, send, rpc, health, mention/reply addressing, forwardAll, loop prevention, retry",
);
