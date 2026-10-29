import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import yaml from "js-yaml";

import {
  Config,
  loadConfig,
  persistApiKeys,
  persistCatalog,
} from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { StatsRecorder } from "../src/stats/recorder";
import { hashApiKey } from "../src/utils/common";
import { GoKeyPool } from "../src/opencode-go/pool";
import { UsageScanner } from "../src/opencode-go/usage";
import { describeGoModel, SKIPPED } from "../src/opencode-go/models";

const ADMIN = "sk-admin-0123456789abcdef";
const STD = "sk-standard-0123456789abcdef";
const GO_A = "go-key-AAAAAAAAAAAAAAAAAAAA";
const GO_B = "go-key-BBBBBBBBBBBBBBBBBBBB";
const GO_C = "go-key-CCCCCCCCCCCCCCCCCCCC";
const START = Date.parse("2026-10-29T12:00:00.000Z");

interface Seen {
  path: string;
  auth: string | undefined;
  apiKey: string | undefined;
  ua: string | undefined;
  session: string | undefined;
  body: any;
}

async function startFakeOpenCodeGo() {
  const seen: Seen[] = [];
  const refuse = new Map<string, number>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {}
      const key = (req.headers.authorization || "").replace(/^Bearer /, "");
      if (req.url === "/v1/models") {
        const status = refuse.get(key);
        if (status) {
          res.writeHead(status, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "refused" } }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            data: [
              { id: "kimi-k3" },
              { id: "glm-5.3-flash" },
              { id: "deepseek-v4.1-flash" },
              { id: "muse-spark-1.3-contributor" },
              { id: "brand-new-model-9" },
            ],
          }),
        );
      }
      seen.push({
        path: req.url || "",
        auth: req.headers.authorization,
        apiKey: req.headers["x-api-key"] as string | undefined,
        ua: req.headers["user-agent"],
        session: req.headers["x-opencode-session"] as string | undefined,
        body,
      });
      const status = refuse.get(key);
      if (status) {
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            error: { message: `go says ${status} for ${key.slice(-4)}` },
          }),
        );
      }
      if (req.url?.includes("/anthropic/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            id: "m1",
            type: "message",
            content: [{ type: "text", text: "hi" }],
            usage: {
              input_tokens: 40,
              output_tokens: 8,
              cache_read_input_tokens: 5,
            },
          }),
        );
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
        res.write(ev({ choices: [{ delta: { content: "he" } }] }));
        res.write(ev({ choices: [{ delta: { content: "llo" } }] }));
        res.write(
          ev({
            choices: [],
            usage: {
              prompt_tokens: 30,
              completion_tokens: 6,
              prompt_tokens_details: { cached_tokens: 10 },
              completion_tokens_details: { reasoning_tokens: 2 },
            },
          }),
        );
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "c1",
          model: body.model,
          choices: [{ message: { role: "assistant", content: "hello" } }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    refuse,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function startApp(
  t: test.TestContext,
  go: { url: string },
  opts: { keys?: string[]; limit?: number } = {},
) {
  const clock = { t: START };
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "go-test-"));
  const cfgPath = path.join(authDir, "config.yaml");
  const keys: any[] = [
    { name: "boss", key: ADMIN, models: ["*"], admin: true },
    {
      name: "std",
      key: STD,
      models: ["gpt-6-luna", "@standard"],
      ...(opts.limit ? { "daily-token-limit": opts.limit } : {}),
    },
  ];
  fs.writeFileSync(cfgPath, yaml.dump({ "api-keys": keys }));
  const stats = new StatsRecorder();
  stats.start(authDir);
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": keys,
    "opencode-go": { keys: opts.keys ?? [GO_A, GO_B], "base-url": go.url },
    models: [
      { id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" },
      {
        id: "go/glm-5.3-flash",
        name: "GLM-5.3 Flash (OpenCode Go)",
        access: "standard",
      },
      { id: "go/kimi-k3", name: "Kimi K3 (OpenCode Go)", access: "on_request" },
    ],
    "body-limit": "1mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 5000,
      "stream-messages-ms": 5000,
      "count-tokens-ms": 5000,
    },
    stats: { enabled: true },
    debug: "off",
  };
  const app = createServer(config, buildRegistry(authDir), stats, {
    persistKeys: persistApiKeys(cfgPath),
    persistCatalog: persistCatalog(cfgPath),
    now: () => clock.t,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(async () => {
    server.close();
    await stats.stop();
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (
    method: string,
    p: string,
    key: string | null,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body: json, text };
  };
  const chat = (
    key: string,
    model: string,
    extra: object = {},
    headers: Record<string, string> = {},
  ) =>
    call(
      "POST",
      "/v1/chat/completions",
      key,
      { model, messages: [{ role: "user", content: "hi" }], ...extra },
      headers,
    );
  return { call, chat, clock, stats, authDir };
}

test("the pool starts with the key that last worked for that model, and wraps around", () => {
  const pool = new GoKeyPool([GO_A, GO_B, GO_C]);
  assert.deepEqual(pool.order("m"), [0, 1, 2]);
  pool.markGood("m", 2);
  assert.deepEqual(pool.order("m"), [2, 0, 1]);
  assert.deepEqual(
    pool.order("other"),
    [0, 1, 2],
    "another model keeps its own preference",
  );
  assert.equal(
    pool.label(1).includes(GO_B),
    false,
    "a label never contains the key",
  );
  assert.match(pool.label(1), /go-key-2 \(\.\.\.BBBB\)/);
  assert.equal(JSON.stringify(pool.describe()).includes(GO_A), false);
});

test("usage is read from OpenAI chat, Responses and Anthropic replies, streamed or not", () => {
  const chat = new UsageScanner();
  chat.whole(
    JSON.stringify({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    }),
  );
  assert.deepEqual(chat.usage(), {
    inputTokens: 12,
    outputTokens: 4,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 3,
    reasoningOutputTokens: 0,
  });

  const responses = new UsageScanner();
  responses.whole(
    JSON.stringify({
      response: {
        usage: {
          input_tokens: 20,
          output_tokens: 9,
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    }),
  );
  assert.equal(responses.usage()!.outputTokens, 9);
  assert.equal(responses.usage()!.reasoningOutputTokens, 4);

  const stream = new UsageScanner();
  stream.feed(
    Buffer.from(
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":50,"output_tokens":1}}}\n\ndata: {"usage":{"out',
    ),
  );
  stream.feed(Buffer.from('put_tokens":22}}\n\ndata: [DONE]\n\n'));
  stream.end();
  assert.equal(stream.usage()!.inputTokens, 50);
  assert.equal(
    stream.usage()!.outputTokens,
    22,
    "running totals keep the largest figure, and a chunk split mid-line still counts",
  );

  const none = new UsageScanner();
  none.whole("not json");
  assert.equal(none.usage(), null);
});

test("config accepts a key list, and rejects short, duplicate and malformed entries", () => {
  const cleanup: string[] = [];
  const load = (opencodeGo: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go-cfg-"));
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(
      file,
      yaml.dump({
        "api-keys": [{ name: "a", key: ADMIN, models: ["*"], admin: true }],
        "opencode-go": opencodeGo,
      }),
    );
    cleanup.push(dir);
    return () => loadConfig(file);
  };
  assert.deepEqual(load({ keys: [GO_A, GO_B] })()["opencode-go"], {
    keys: [GO_A, GO_B],
  });
  assert.equal(
    load({ keys: [GO_A], "base-url": "http://127.0.0.1:9/" })()["opencode-go"]![
      "base-url"
    ],
    "http://127.0.0.1:9",
  );
  assert.throws(load({ keys: ["short"] }), /at least 20/);
  assert.throws(load({ keys: [GO_A, GO_A] }), /duplicate/);
  assert.throws(load({ keys: "nope" }), /must be a list/);
  assert.throws(load({ keys: [GO_A], "base-url": "ftp://x" }), /http\(s\)/);
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

test("cheap Go models are filed standard, dear ones on request, unknown ones on request, training ones skipped", () => {
  assert.deepEqual(describeGoModel("glm-5.3-flash"), {
    id: "go/glm-5.3-flash",
    name: "GLM-5.3 Flash (OpenCode Go)",
    access: "standard",
  });
  assert.equal(describeGoModel("kimi-k3").access, "on_request");
  assert.equal(describeGoModel("deepseek-v4-pro").access, "on_request");
  assert.equal(describeGoModel("grok-4.7").access, "on_request");
  assert.equal(describeGoModel("deepseek-v4.1-flash").access, "standard");
  const unknown = describeGoModel("brand-new-model-9");
  assert.equal(
    unknown.access,
    "on_request",
    "a model Go adds later is never open to everyone by accident",
  );
  assert.equal(unknown.name, "Brand New Model 9 (OpenCode Go)");
  assert.ok(SKIPPED["muse-spark-1.3-contributor"]);
});

test("a Go model is routed to Go with the model name stripped, our caller's key hidden, and usage counted", async (t) => {
  const go = await startFakeOpenCodeGo();
  t.after(() => go.close());
  const { chat, stats } = await startApp(t, go);
  const r = await chat(
    STD,
    "go/glm-5.3-flash",
    {},
    { "x-opencode-session": "sess-123" },
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.choices[0].message.content, "hello");
  const sent = go.seen.at(-1)!;
  assert.equal(sent.path, "/openai/v1/chat/completions");
  assert.equal(sent.body.model, "glm-5.3-flash", "go/ prefix removed");
  assert.equal(sent.auth, `Bearer ${GO_A}`, "a Go key, never the caller's");
  assert.equal(sent.ua, "dozaldevs-relay/1.0");
  assert.equal(sent.session, "sess-123");
  const rows = stats.usageRows();
  const row = rows.find(
    (x) => x.apiKeyHash === hashApiKey(STD) && x.model === "go/glm-5.3-flash",
  );
  assert.deepEqual(
    [row?.requests, row?.inputTokens, row?.outputTokens],
    [1, 12, 4],
  );
});

test("streaming passes through untouched, asks Go to report usage, and counts it", async (t) => {
  const go = await startFakeOpenCodeGo();
  t.after(() => go.close());
  const { call, stats } = await startApp(t, go);
  const r = await call("POST", "/v1/chat/completions", STD, {
    model: "go/glm-5.3-flash",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.status, 200);
  assert.match(r.text, /data: .*"he"/);
  assert.match(r.text, /\[DONE\]/);
  assert.equal(go.seen.at(-1)!.body.stream_options.include_usage, true);
  const row = stats.usageRows().find((x) => x.model === "go/glm-5.3-flash")!;
  assert.deepEqual(
    [
      row.inputTokens,
      row.outputTokens,
      row.cacheReadInputTokens,
      row.reasoningOutputTokens,
    ],
    [30, 6, 10, 2],
  );
});

test("Anthropic-style requests go to Go's Anthropic endpoint with the key in both headers", async (t) => {
  const go = await startFakeOpenCodeGo();
  t.after(() => go.close());
  const { call, stats } = await startApp(t, go);
  const r = await call(
    "POST",
    "/v1/messages",
    STD,
    {
      model: "go/glm-5.3-flash",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    },
    { "anthropic-version": "2023-06-01" },
  );
  assert.equal(r.status, 200);
  const sent = go.seen.at(-1)!;
  assert.equal(sent.path, "/anthropic/v1/messages");
  assert.equal(sent.apiKey, GO_A);
  assert.equal(sent.auth, `Bearer ${GO_A}`);
  assert.equal(
    stats.usageRows().find((x) => x.model === "go/glm-5.3-flash")!
      .cacheReadInputTokens,
    5,
  );
});

test("when a Go key is refused the next key is used, and that key is remembered for the model", async (t) => {
  const go = await startFakeOpenCodeGo();
  t.after(() => go.close());
  const { chat } = await startApp(t, go);
  go.refuse.set(GO_A, 429);
  assert.equal((await chat(STD, "go/glm-5.3-flash")).status, 200);
  assert.deepEqual(
    go.seen.map((s) => s.auth!.slice(-4)),
    ["AAAA", "BBBB"],
    "tried A, got a limit, fell through to B",
  );
  go.seen.length = 0;
  assert.equal((await chat(STD, "go/glm-5.3-flash")).status, 200);
  assert.deepEqual(
    go.seen.map((s) => s.auth!.slice(-4)),
    ["BBBB"],
    "next time it starts with the key that worked",
  );
  go.seen.length = 0;
  assert.equal(
    (await chat(STD, "go/kimi-k3", {}, {})).status,
    403,
    "a model outside the key's access never reaches Go",
  );
  assert.equal(go.seen.length, 0);
});

test("when every Go key is refused the caller sees Go's own message, not a vague error", async (t) => {
  const go = await startFakeOpenCodeGo();
  t.after(() => go.close());
  const { chat } = await startApp(t, go);
  go.refuse.set(GO_A, 429);
  go.refuse.set(GO_B, 429);
  const r = await chat(STD, "go/glm-5.3-flash");
  assert.equal(r.status, 429);
  assert.match(r.body.error.message, /go says 429/);
  assert.equal(go.seen.length, 2, "every key was tried exactly once");
});

test("a Go outage becomes a clear 502, and a relay with no Go keys says so", async (t) => {
  const go = await startFakeOpenCodeGo();
  const { chat } = await startApp(t, { url: "http://127.0.0.1:1" });
  const r = await chat(STD, "go/glm-5.3-flash");
  assert.equal(r.status, 502);
  assert.equal(r.body.error.type, "upstream_unreachable");
  await go.close();

  const go2 = await startFakeOpenCodeGo();
  t.after(() => go2.close());
  const none = await startApp(t, go2, { keys: [] });
  const r2 = await none.chat(STD, "go/glm-5.3-flash");
  assert.equal(r2.status, 503);
  assert.equal(r2.body.error.type, "provider_not_connected");
});

test("the Standard group opens every standard model, including ones added later, and nothing on request", async (t) => {
  const go = await startFakeOpenCodeGo();
  t.after(() => go.close());
  const { call, chat } = await startApp(t, go);
  assert.equal((await chat(STD, "go/glm-5.3-flash")).status, 200);
  assert.equal(
    (await chat(STD, "go/kimi-k3")).status,
    403,
    "on request means not without a grant",
  );

  await call("POST", "/admin/models", ADMIN, {
    id: "go/hy3",
    name: "Hy3 (OpenCode Go)",
    access: "standard",
  });
  assert.equal(
    (await chat(STD, "go/hy3")).status,
    200,
    "a standard model added later is covered with no key edits",
  );

  await call("POST", "/admin/models", ADMIN, {
    id: "go/glm-5.3-flash",
    name: "GLM-5.3 Flash (OpenCode Go)",
    access: "on_request",
  });
  assert.equal(
    (await chat(STD, "go/glm-5.3-flash")).status,
    403,
    "moving a model to on request closes it for the group",
  );
});

test("a temporary grant opens an on-request Go model, then it closes on its own", async (t) => {
  const go = await startFakeOpenCodeGo();
  t.after(() => go.close());
  const { call, chat, clock } = await startApp(t, go);
  assert.equal((await chat(STD, "go/kimi-k3")).status, 403);
  const made = await call("POST", "/admin/keys/std/grants", ADMIN, {
    models: ["go/kimi-k3"],
    hours: 2,
  });
  assert.equal(made.status, 201);
  assert.equal((await chat(STD, "go/kimi-k3")).status, 200);
  assert.equal(go.seen.at(-1)!.body.model, "kimi-k3");
  clock.t = START + 2 * 3600_000 + 60_000;
  const gone = await chat(STD, "go/kimi-k3");
  assert.equal(gone.status, 403);
  assert.equal(gone.body.error.code, "grant_expired");
});

test("the daily token cap counts Go usage like any other model", async (t) => {
  const go = await startFakeOpenCodeGo();
  t.after(() => go.close());
  const { chat } = await startApp(t, go, { limit: 20 });
  assert.equal(
    (await chat(STD, "go/glm-5.3-flash")).status,
    200,
    "16 tokens used",
  );
  assert.equal(
    (await chat(STD, "go/glm-5.3-flash")).status,
    200,
    "32 now, call already allowed through",
  );
  const over = await chat(STD, "go/glm-5.3-flash");
  assert.equal(over.status, 429);
  assert.equal(over.body.error.type, "daily_token_limit");
});

test("/setup/models lists standard Go models as usable and on-request ones labelled", async (t) => {
  const go = await startFakeOpenCodeGo();
  t.after(() => go.close());
  const { call } = await startApp(t, go);
  const r = await call("GET", "/setup/models", STD);
  const lines = r.text
    .trim()
    .split("\n")
    .map((l) => l.split("\t"));
  assert.deepEqual(
    lines.find((l) => l[0] === "go/glm-5.3-flash"),
    ["go/glm-5.3-flash", "allowed", "GLM-5.3 Flash (OpenCode Go)"],
  );
  assert.deepEqual(
    lines.find((l) => l[0] === "go/kimi-k3"),
    ["go/kimi-k3", "on_request", "Kimi K3 (OpenCode Go) (on request)"],
  );
  assert.equal(
    (await call("GET", "/v1/models", STD)).body.data.some(
      (m: any) => m.id === "go/glm-5.3-flash",
    ),
    true,
  );
  assert.equal(
    (await call("GET", "/v1/models", STD)).body.data.some(
      (m: any) => m.id === "go/kimi-k3",
    ),
    false,
  );
});

test("admin can see which Go keys are loaded (labels only) and sync Go's model list into the relay", async (t) => {
  const go = await startFakeOpenCodeGo();
  t.after(() => go.close());
  const { call, chat } = await startApp(t, go);
  await chat(STD, "go/glm-5.3-flash");
  const status = await call("GET", "/admin/go", ADMIN);
  assert.equal(status.body.connected, true);
  assert.equal(status.body.keys.length, 2);
  assert.equal(
    JSON.stringify(status.body).includes(GO_A),
    false,
    "no key ever leaves the relay",
  );
  assert.equal(status.body.keys[0].last_status, 200);

  const sync = await call("POST", "/admin/go/sync", ADMIN);
  assert.equal(sync.status, 200);
  const addedIds = sync.body.added.map((m: any) => m.id).sort();
  assert.deepEqual(
    addedIds,
    ["go/brand-new-model-9", "go/deepseek-v4.1-flash"],
    "only models not already listed",
  );
  assert.equal(
    sync.body.added.find((m: any) => m.id === "go/deepseek-v4.1-flash").access,
    "standard",
  );
  assert.equal(
    sync.body.added.find((m: any) => m.id === "go/brand-new-model-9").access,
    "on_request",
  );
  assert.deepEqual(
    sync.body.skipped.map((s: any) => s.id),
    ["muse-spark-1.3-contributor"],
  );
  assert.deepEqual(sync.body.already_listed.sort(), [
    "glm-5.3-flash",
    "kimi-k3",
  ]);

  const again = await call("POST", "/admin/go/sync", ADMIN);
  assert.deepEqual(again.body.added, [], "running it again changes nothing");

  assert.equal(
    (await call("GET", "/admin/go", STD)).status,
    403,
    "members cannot see or sync",
  );
  assert.equal((await call("POST", "/admin/go/sync", STD)).status, 403);
});

test("sync moves on from a refused key, and reports clearly when none works or none is loaded", async (t) => {
  const go = await startFakeOpenCodeGo();
  t.after(() => go.close());
  const { call } = await startApp(t, go);
  go.refuse.set(GO_A, 401);
  assert.equal(
    (await call("POST", "/admin/go/sync", ADMIN)).status,
    200,
    "the second key still works",
  );
  go.refuse.set(GO_B, 401);
  const dead = await call("POST", "/admin/go/sync", ADMIN);
  assert.equal(dead.status, 502);

  const go2 = await startFakeOpenCodeGo();
  t.after(() => go2.close());
  const none = await startApp(t, go2, { keys: [] });
  assert.equal((await none.call("POST", "/admin/go/sync", ADMIN)).status, 409);
  assert.equal(
    (await none.call("GET", "/admin/go", ADMIN)).body.connected,
    false,
  );
});
