import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import yaml from "js-yaml";

import { ApiKeyEntry, CatalogModel, Config } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { saveToken } from "../src/auth/token-storage";
import { StatsRecorder } from "../src/stats/recorder";

const ADMIN = "sk-admin-0123456789abcdef";
const FULL = "sk-full-0123456789abcdef";
const TEXT_ONLY = "sk-text-0123456789abcdef";
const GO_A = "go-key-AAAAAAAAAAAAAAAAAAAA";
const GO_B = "go-key-BBBBBBBBBBBBBBBBBBBB";
const PNG = Buffer.from("not really a png but bytes").toString("base64");
const DATA_URL = `data:image/png;base64,${PNG}`;

const CATALOG: CatalogModel[] = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" },
  { id: "gpt-image-2", name: "GPT Image 2", access: "standard", kind: "image" },
  {
    id: "go/image-gpt-6-luna",
    name: "GPT Image via Luna (OpenCode Go)",
    access: "on_request",
    kind: "image",
  },
];

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: any;
}

async function startGo(
  reply: (key: string) => { status: number; body: unknown } = () => ({
    status: 200,
    body: {
      output: [
        {
          type: "image_generation_call",
          result: PNG,
          revised_prompt: "a revised prompt",
          size: "1024x1024",
          quality: "low",
        },
        { type: "message" },
      ],
      usage: { input_tokens: 1000, output_tokens: 50 },
      tool_usage: { image_gen: { input_tokens: 40, output_tokens: 200 } },
    },
  }),
) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const key = (req.headers.authorization || "").replace(/^Bearer /, "");
      if (!req.headers["x-opencode-session"]) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({ error: { message: "missing session" } }),
        );
      }
      seen.push({
        url: req.url || "",
        headers: req.headers as Record<string, string>,
        body: raw ? JSON.parse(raw) : {},
      });
      const r = reply(key);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

type Upstream = (n: number, seen: Seen) => { status: number; body: unknown };

const okImage = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    created: 1,
    background: "opaque",
    data: [{ b64_json: PNG, generation_id: "g1" }],
    output_format: "png",
    quality: "low",
    size: "1254x1254",
    usage: { input_tokens: 14, output_tokens: 515, total_tokens: 529 },
    ...extra,
  },
});

async function startApp(
  t: test.TestContext,
  opts: {
    go?: { url: string };
    upstream?: Upstream;
    catalog?: CatalogModel[];
    codex?: boolean;
  } = {},
) {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "images-"));
  if (opts.codex !== false) {
    saveToken(authDir, {
      accessToken: "codex-access",
      refreshToken: "codex-refresh",
      email: "codex@example.com",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      accountUuid: "chatgpt-account-id",
      provider: "codex",
    });
  }
  const keys: ApiKeyEntry[] = [
    { name: "boss", key: ADMIN, models: ["*"], admin: true },
    { name: "full", key: FULL, models: ["@standard"] },
    { name: "text", key: TEXT_ONLY, models: ["gpt-6-luna"] },
  ];
  const cfgPath = path.join(authDir, "config.yaml");
  fs.writeFileSync(cfgPath, yaml.dump({ "api-keys": keys }));
  const stats = new StatsRecorder();
  stats.start(authDir);
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": keys,
    ...(opts.go && {
      "opencode-go": { keys: [GO_A, GO_B], "base-url": opts.go.url },
    }),
    models: opts.catalog ?? CATALOG,
    "body-limit": "50mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 5000,
      "stream-messages-ms": 5000,
      "count-tokens-ms": 5000,
    },
    stats: { enabled: true },
    debug: "off",
  } as any;
  const registry = buildRegistry(authDir);
  for (const p of registry.all()) p.manager.load();

  const upstream: Seen[] = [];
  let count = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith("https://chatgpt.com/backend-api/codex/images/")) {
      const seen: Seen = {
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body),
      };
      upstream.push(seen);
      const r = (opts.upstream ?? (() => okImage()))(count++, seen);
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const app = createServer(config, registry, stats, {});
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(async () => {
    globalThis.fetch = realFetch;
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
    const res = await realFetch(base + p, {
      method,
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body: json, text };
  };
  return { call, upstream };
}

test("a key that may use images gets a picture from the ChatGPT subscription, with the usual OpenAI shape", async (t) => {
  const { call, upstream } = await startApp(t);
  const r = await call("POST", "/v1/images/generations", FULL, {
    prompt: "a blue square",
    size: "1024x1024",
    quality: "low",
    background: "transparent",
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].b64_json, PNG);
  assert.equal(r.body.output_format, "png");
  assert.equal(r.body.size, "1254x1254");
  assert.deepEqual(r.body.usage, {
    input_tokens: 14,
    output_tokens: 515,
    total_tokens: 529,
  });

  assert.equal(upstream.length, 1);
  const up = upstream[0];
  assert.equal(
    up.url,
    "https://chatgpt.com/backend-api/codex/images/generations",
  );
  assert.equal(up.headers.Authorization, "Bearer codex-access");
  assert.equal(up.headers["ChatGPT-Account-ID"], "chatgpt-account-id");
  assert.deepEqual(up.body, {
    prompt: "a blue square",
    size: "1024x1024",
    quality: "low",
    background: "transparent",
  });
});

test("n asks for several pictures: each is its own upstream call, the usage adds up, and a partial failure still returns what worked", async (t) => {
  const { call, upstream } = await startApp(t, {
    upstream: (i) =>
      i === 2
        ? { status: 400, body: { error: { message: "blocked by safety" } } }
        : okImage(),
  });
  const r = await call("POST", "/v1/images/generations", FULL, {
    prompt: "three please",
    n: 3,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(upstream.length, 3);
  assert.equal(r.body.data.length, 2);
  assert.equal(r.body.usage.output_tokens, 1030);
  assert.match(r.body.warning, /1 of 3 images could not be made/);

  const all = await startApp(t, {
    upstream: () => ({
      status: 400,
      body: { error: { message: "blocked by safety" } },
    }),
  });
  const bad = await all.call("POST", "/v1/images/generations", FULL, {
    prompt: "x",
    n: 2,
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.message, "blocked by safety");
});

test("edits take images as data URLs, send them as the upstream expects, and refuse what cannot work", async (t) => {
  const { call, upstream } = await startApp(t);
  const ok = await call("POST", "/v1/images/edits", FULL, {
    prompt: "make it red",
    images: [DATA_URL, { image_url: DATA_URL }],
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(
    upstream[0].url,
    "https://chatgpt.com/backend-api/codex/images/edits",
  );
  assert.deepEqual(upstream[0].body.images, [
    { image_url: DATA_URL },
    { image_url: DATA_URL },
  ]);

  const none = await call("POST", "/v1/images/edits", FULL, {
    prompt: "make it red",
  });
  assert.equal(none.status, 400);
  assert.match(none.body.error.message, /send 1 to 5 images/);
  const plain = await call("POST", "/v1/images/edits", FULL, {
    prompt: "x",
    images: ["https://example.com/a.png"],
  });
  assert.equal(plain.status, 400);
  assert.match(plain.body.error.message, /data URL/);
  const mask = await call("POST", "/v1/images/edits", FULL, {
    prompt: "x",
    images: [DATA_URL],
    mask: DATA_URL,
  });
  assert.match(mask.body.error.message, /masks are not supported/);
  const form = await call("POST", "/v1/images/edits", FULL, "--x\r\n", {
    "content-type": "multipart/form-data; boundary=x",
  });
  assert.equal(form.status, 415);
  const six = await call("POST", "/v1/images/edits", FULL, {
    prompt: "x",
    images: Array(6).fill(DATA_URL),
  });
  assert.equal(six.status, 400);
  assert.equal(upstream.length, 1, "nothing refused ever reached the upstream");
});

test("bad requests are refused before any picture is paid for", async (t) => {
  const { call, upstream } = await startApp(t);
  const cases: Array<[unknown, RegExp]> = [
    [{}, /prompt is required/],
    [{ prompt: "   " }, /prompt is required/],
    [{ prompt: "x", n: 5 }, /n must be a whole number from 1 to 4/],
    [{ prompt: "x", n: 0 }, /n must be/],
    [{ prompt: "x", size: "huge" }, /size must be/],
    [{ prompt: "x", quality: "ultra" }, /quality must be one of/],
    [{ prompt: "x", background: "pink" }, /background must be one of/],
    [{ prompt: "x", response_format: "url" }, /b64_json/],
    [{ prompt: "x", image: DATA_URL }, /only makes new images/],
    [{ prompt: "x", model: "gpt-6-luna" }, /is not an image model/],
    [{ prompt: "x".repeat(32_001) }, /at most 32000 characters/],
  ];
  for (const [body, re] of cases) {
    const r = await call("POST", "/v1/images/generations", FULL, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.match(r.body.error.message, re);
  }
  assert.equal(upstream.length, 0);
});

test("who may make images follows the model list: standard for everyone on the standard group, on request for the Go one, and keys without it are told where to ask", async (t) => {
  const go = await startGo();
  t.after(() => go.close());
  const { call, upstream } = await startApp(t, { go });

  const text = await call("POST", "/v1/images/generations", TEXT_ONLY, {
    prompt: "x",
  });
  assert.equal(text.status, 403);
  assert.equal(text.body.error.type, "model_not_allowed");
  assert.match(
    text.body.error.message,
    /"gpt-image-2" is not on your key\. Ask for it at http:\/\/127\.0\.0\.1:\d+\/account\?ask=gpt-image-2/,
  );

  const full = await call("POST", "/v1/images/generations", FULL, {
    prompt: "x",
  });
  assert.equal(full.status, 200);

  const goDenied = await call("POST", "/v1/images/generations", FULL, {
    prompt: "x",
    model: "go/image-gpt-6-luna",
  });
  assert.equal(
    goDenied.status,
    403,
    "the Go picture model is on request, so the standard group does not open it",
  );

  const loan = await call("POST", "/admin/keys/full/grants", ADMIN, {
    models: ["go/image-gpt-6-luna"],
    hours: 1,
  });
  assert.equal(loan.status, 201);
  const goOk = await call("POST", "/v1/images/generations", FULL, {
    prompt: "x",
    model: "go/image-gpt-6-luna",
  });
  assert.equal(goOk.status, 200, goOk.text);
  assert.equal(upstream.length, 1, "the Go picture did not touch ChatGPT");

  const none = await call("POST", "/v1/images/generations", null, {
    prompt: "x",
  });
  assert.equal(none.status, 401);
});

test("the Go fallback asks Go's Luna model for a picture with OpenAI's image tool, counts the cost, and rotates keys", async (t) => {
  const go = await startGo((key) =>
    key === GO_A
      ? { status: 429, body: { error: { message: "limit" } } }
      : {
          status: 200,
          body: {
            output: [
              {
                type: "image_generation_call",
                result: PNG,
                revised_prompt: "rp",
                size: "1024x1024",
                quality: "low",
              },
            ],
            usage: { input_tokens: 1000, output_tokens: 50 },
            tool_usage: { image_gen: { input_tokens: 40, output_tokens: 200 } },
          },
        },
  );
  t.after(() => go.close());
  const { call } = await startApp(t, { go });
  const r = await call("POST", "/v1/images/edits", ADMIN, {
    model: "go/image-gpt-6-luna",
    prompt: "make it red",
    images: [DATA_URL],
    quality: "low",
    size: "1024x1024",
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data[0].b64_json, PNG);
  assert.equal(r.body.data[0].revised_prompt, "rp");
  assert.deepEqual(r.body.usage, {
    input_tokens: 1040,
    output_tokens: 250,
    total_tokens: 1290,
  });

  assert.equal(
    go.seen.length,
    2,
    "the first key was refused, the second answered",
  );
  const sent = go.seen[1].body;
  assert.equal(go.seen[1].url, "/openai/v1/responses");
  assert.equal(sent.model, "gpt-6-luna");
  assert.deepEqual(sent.tools, [
    { type: "image_generation", size: "1024x1024", quality: "low" },
  ]);
  assert.deepEqual(sent.tool_choice, { type: "image_generation" });
  assert.deepEqual(sent.input[0].content, [
    { type: "input_text", text: "make it red" },
    { type: "input_image", image_url: DATA_URL },
  ]);
  assert.match(
    String(go.seen[1].headers["x-opencode-session"]),
    /^relay-[0-9a-f]{16}$/,
  );

  const usage = await call("GET", "/admin/usage?days=1", ADMIN);
  const row = usage.body.rows.find(
    (x: any) => x.model === "go/image-gpt-6-luna",
  );
  assert.ok(row, "the picture shows in the usage report");
  assert.equal(row.inputTokens, 1040);
});

test("a Go answer without a picture, and Go not being connected, are explained", async (t) => {
  const go = await startGo(() => ({
    status: 200,
    body: { output: [{ type: "message" }], usage: {} },
  }));
  t.after(() => go.close());
  const a = await startApp(t, { go });
  const none = await a.call("POST", "/v1/images/generations", ADMIN, {
    prompt: "x",
    model: "go/image-gpt-6-luna",
  });
  assert.equal(none.status, 502);
  assert.match(none.body.error.message, /without a picture/);

  const b = await startApp(t);
  const off = await b.call("POST", "/v1/images/generations", ADMIN, {
    prompt: "x",
    model: "go/image-gpt-6-luna",
  });
  assert.equal(off.status, 503);
  assert.match(off.body.error.message, /not connected/);
});

test("when ChatGPT answers an error the caller sees its words, and a relay with no image models says so", async (t) => {
  const a = await startApp(t, {
    upstream: () => ({
      status: 400,
      body: {
        error: { message: "Your request was rejected by the safety system." },
      },
    }),
  });
  const r = await a.call("POST", "/v1/images/generations", FULL, {
    prompt: "x",
  });
  assert.equal(r.status, 400);
  assert.equal(
    r.body.error.message,
    "Your request was rejected by the safety system.",
  );

  const b = await startApp(t, {
    catalog: CATALOG.filter((m) => m.kind !== "image"),
  });
  const none = await b.call("POST", "/v1/images/generations", ADMIN, {
    prompt: "x",
  });
  assert.equal(none.status, 404);
  assert.equal(none.body.error.type, "no_image_models");

  const c = await startApp(t, { codex: false });
  const off = await c.call("POST", "/v1/images/generations", ADMIN, {
    prompt: "x",
  });
  assert.equal(off.status, 503);
});

test("image models are listed as images for tools that ask, and never offered to OpenCode as chat models", async (t) => {
  const { call } = await startApp(t);
  const list = await call("GET", "/v1/models", ADMIN);
  const img = list.body.data.find((m: any) => m.id === "gpt-image-2");
  assert.equal(img.type, "image");
  const setup = await call("GET", "/setup/models", FULL);
  assert.match(setup.text, /^gpt-6-luna\tallowed\t/m);
  assert.equal(setup.text.includes("gpt-image-2"), false);
  assert.equal(setup.text.includes("image-gpt-6-luna"), false);
  const models = await call("GET", "/admin/models", ADMIN);
  assert.equal(
    models.body.models.find((m: any) => m.id === "gpt-image-2").kind,
    "image",
  );
});

test("a picture is recorded in the usage report under the image model", async (t) => {
  const { call } = await startApp(t);
  await call("POST", "/v1/images/generations", FULL, { prompt: "x" });
  const usage = await call("GET", "/admin/usage?days=1", ADMIN);
  const row = usage.body.rows.find((x: any) => x.model === "gpt-image-2");
  assert.ok(row);
  assert.equal(row.requests, 1);
  assert.equal(row.outputTokens, 515);
});
