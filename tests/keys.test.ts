import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { ApiKeyEntry, Config, persistApiKeys } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { StatsRecorder } from "../src/stats/recorder";
import { KeyStore, KeyStoreError } from "../src/keys/store";
import { hashApiKey } from "../src/utils/common";

const ADMIN = "sk-admin-0123456789abcdef";
const MARIA = "sk-maria-0123456789abcdef";
const BOB = "sk-bob-0123456789abcdefgh";

function entries(): ApiKeyEntry[] {
  return [
    { name: "boss", key: ADMIN, models: ["*"], admin: true },
    {
      name: "maria",
      key: MARIA,
      models: ["gpt-6-luna"],
      "daily-token-limit": 1000,
    },
    { name: "bob", key: BOB, models: ["gpt-6-luna"] },
  ];
}

function makeConfig(authDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": entries(),
    "body-limit": "1mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    stats: { enabled: true },
    debug: "off",
  };
}

async function startApp(t: test.TestContext) {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-keys-"));
  const configPath = path.join(authDir, "config.yaml");
  fs.writeFileSync(configPath, yaml.dump({ port: 1, "api-keys": entries() }));
  const recorder = new StatsRecorder();
  recorder.start(authDir);
  const app = createServer(
    makeConfig(authDir),
    buildRegistry(authDir),
    recorder,
    { persistKeys: persistApiKeys(configPath) },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(async () => {
    server.close();
    await recorder.stop();
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  const port = (server.address() as any).port;
  const call = async (
    method: string,
    p: string,
    key: string | null,
    body?: unknown,
  ) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { call, recorder, configPath };
}

function recordUsage(
  recorder: StatsRecorder,
  key: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
) {
  recorder.record({
    apiKeyHash: hashApiKey(key),
    ip: "1.1.1.1",
    ua: "t",
    endpoint: "POST /v1/chat/completions",
    model,
    provider: "codex",
    accountEmail: "a@b.c",
    status: "success",
    failureKind: null,
    statusCode: 200,
    latencyMs: 5,
    usage: {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    },
  });
}

const chat = (model?: string) => ({
  ...(model ? { model } : {}),
  messages: [{ role: "user", content: "hi" }],
});

test("a key is refused for a model outside its allowlist, before any upstream call", async (t) => {
  const { call } = await startApp(t);
  const denied = await call(
    "POST",
    "/v1/chat/completions",
    MARIA,
    chat("gpt-6-astra"),
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.type, "model_not_allowed");

  const missing = await call("POST", "/v1/chat/completions", MARIA, chat());
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.type, "model_required");

  const allowed = await call(
    "POST",
    "/v1/chat/completions",
    MARIA,
    chat("gpt-6-luna"),
  );
  assert.notEqual(allowed.body?.error?.type, "model_not_allowed");
  assert.notEqual(allowed.status, 403);
});

test("the allowlist applies to the other model-taking endpoints too", async (t) => {
  const { call } = await startApp(t);
  for (const p of [
    "/v1/responses",
    "/v1/messages",
    "/v1/messages/count_tokens",
  ]) {
    const res = await call("POST", p, MARIA, chat("gpt-6-astra"));
    assert.equal(res.status, 403, p);
  }
});

test("an alias cannot sneak past an allowlist that names the real model", async (t) => {
  const { call } = await startApp(t);
  const lim = await call("PATCH", "/admin/keys/maria", ADMIN, {
    models: ["claude-opus-4-7"],
  });
  assert.equal(lim.status, 200);
  const viaAlias = await call("POST", "/v1/messages", MARIA, chat("opus"));
  assert.notEqual(viaAlias.body?.error?.type, "model_not_allowed");
  const other = await call("POST", "/v1/messages", MARIA, chat("sonnet"));
  assert.equal(other.body.error.type, "model_not_allowed");
});

test("the daily token cap stops only the key that hit it", async (t) => {
  const { call, recorder } = await startApp(t);
  recordUsage(recorder, MARIA, "gpt-6-luna", 600, 300);
  const under = await call(
    "POST",
    "/v1/chat/completions",
    MARIA,
    chat("gpt-6-luna"),
  );
  assert.notEqual(under.status, 429);

  recordUsage(recorder, MARIA, "gpt-6-luna", 100, 100);
  const over = await call(
    "POST",
    "/v1/chat/completions",
    MARIA,
    chat("gpt-6-luna"),
  );
  assert.equal(over.status, 429);
  assert.equal(over.body.error.type, "daily_token_limit");

  const other = await call(
    "POST",
    "/v1/chat/completions",
    BOB,
    chat("gpt-6-luna"),
  );
  assert.notEqual(other.status, 429);
  assert.equal((await call("GET", "/v1/models", MARIA)).status, 200);
});

test("usage from a previous UTC day does not count toward today's cap", async (t) => {
  const { recorder } = await startApp(t);
  recorder.applyEvent({
    v: 1,
    ts: "2020-01-01T10:00:00.000Z",
    apiKeyHash: hashApiKey(MARIA),
    ip: "",
    ua: "",
    endpoint: "POST /v1/chat/completions",
    model: "gpt-6-luna",
    provider: "codex",
    accountEmail: null,
    status: "success",
    failureKind: null,
    statusCode: 200,
    latencyMs: 1,
    usage: {
      inputTokens: 5000,
      outputTokens: 5000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    },
  });
  assert.equal(recorder.tokensOnDay(hashApiKey(MARIA), "2020-01-01"), 10000);
  assert.equal(
    recorder.tokensOnDay(
      hashApiKey(MARIA),
      new Date().toISOString().slice(0, 10),
    ),
    0,
  );
});

test("only admin keys reach /admin; members get 403, unknown keys 403, no key 401", async (t) => {
  const { call } = await startApp(t);
  assert.equal((await call("GET", "/admin/stats", ADMIN)).status, 200);
  assert.equal((await call("GET", "/admin/stats", MARIA)).status, 403);
  assert.equal((await call("GET", "/admin/keys", MARIA)).status, 403);
  assert.equal((await call("POST", "/admin/reload", MARIA)).status, 403);
  assert.equal(
    (await call("GET", "/admin/stats", "sk-unknown-0123456789abc")).status,
    403,
  );
  assert.equal((await call("GET", "/admin/stats", null)).status, 401);
});

test("admin can mint, restrict, disable and delete keys with no restart, and the file follows", async (t) => {
  const { call, configPath } = await startApp(t);

  const made = await call("POST", "/admin/keys", ADMIN, {
    name: "newhire",
    models: ["gpt-6-luna"],
    daily_token_limit: 500,
  });
  assert.equal(made.status, 201);
  const secret = made.body.key as string;
  assert.match(secret, /^sk-[0-9a-f]{64}$/);
  assert.equal(
    (await call("POST", "/v1/chat/completions", secret, chat("gpt-6-astra")))
      .status,
    403,
  );

  const listed = await call("GET", "/admin/keys", ADMIN);
  const row = listed.body.keys.find((k: any) => k.name === "newhire");
  assert.equal(row.key_suffix, secret.slice(-4));
  assert.equal(row.daily_token_limit, 500);
  assert.equal(JSON.stringify(listed.body).includes(secret), false);

  const onDisk = yaml.load(fs.readFileSync(configPath, "utf-8")) as any;
  assert.ok(onDisk["api-keys"].some((k: any) => k.key === secret));

  await call("PATCH", "/admin/keys/newhire", ADMIN, { disabled: true });
  const off = await call(
    "POST",
    "/v1/chat/completions",
    secret,
    chat("gpt-6-luna"),
  );
  assert.equal(off.status, 403);
  assert.equal(off.body.error.message, "API key disabled");

  await call("PATCH", "/admin/keys/newhire", ADMIN, {
    disabled: false,
    daily_token_limit: null,
  });
  const row2 = (await call("GET", "/admin/keys", ADMIN)).body.keys.find(
    (k: any) => k.name === "newhire",
  );
  assert.equal(row2.daily_token_limit, null);

  assert.equal(
    (await call("DELETE", "/admin/keys/newhire", ADMIN)).status,
    204,
  );
  assert.equal(
    (await call("POST", "/v1/chat/completions", secret, chat("gpt-6-luna")))
      .status,
    403,
  );
});

test("admin key management rejects bad input and refuses to lock the relay out", async (t) => {
  const { call } = await startApp(t);
  assert.equal(
    (await call("POST", "/admin/keys", ADMIN, { name: "maria", models: ["*"] }))
      .status,
    409,
  );
  assert.equal(
    (await call("POST", "/admin/keys", ADMIN, { name: "x y", models: ["*"] }))
      .status,
    400,
  );
  assert.equal(
    (await call("POST", "/admin/keys", ADMIN, { name: "nomodels", models: [] }))
      .status,
    400,
    "an explicitly empty list is still refused; leaving models out means standard",
  );
  assert.equal(
    (await call("PATCH", "/admin/keys/ghost", ADMIN, {})).status,
    404,
  );
  assert.equal(
    (await call("PATCH", "/admin/keys/boss", ADMIN, { disabled: true })).status,
    409,
  );
  assert.equal((await call("DELETE", "/admin/keys/boss", ADMIN)).status, 409);
});

test("/admin/usage reports tokens by key name, model and day", async (t) => {
  const { call, recorder } = await startApp(t);
  recordUsage(recorder, MARIA, "gpt-6-luna", 100, 50);
  recordUsage(recorder, MARIA, "gpt-6-astra", 10, 5);
  recordUsage(recorder, BOB, "gpt-6-luna", 7, 3);
  const res = await call("GET", "/admin/usage?days=1", ADMIN);
  assert.equal(res.status, 200);
  const byKey = Object.fromEntries(
    res.body.by_key.map((k: any) => [k.name, k.tokens]),
  );
  assert.equal(byKey.maria, 165);
  assert.equal(byKey.bob, 10);
  const astra = res.body.rows.find(
    (r: any) => r.name === "maria" && r.model === "gpt-6-astra",
  );
  assert.equal(astra.inputTokens, 10);
  assert.equal(astra.requests, 1);
});

test("a failed config write leaves the live key set untouched", () => {
  const store = new KeyStore(entries(), {
    statsEnabled: true,
    persist: () => {
      throw new Error("disk full");
    },
  });
  assert.throws(
    () => store.create({ name: "z", models: ["*"] }),
    (e: any) => e instanceof KeyStoreError && e.status === 500,
  );
  assert.equal(store.list().length, 3);
});

test("daily-token-limit is refused when stats are off", () => {
  const store = new KeyStore(entries(), { statsEnabled: false });
  assert.throws(
    () => store.create({ name: "z", models: ["*"], "daily-token-limit": 5 }),
    /stats/,
  );
});
