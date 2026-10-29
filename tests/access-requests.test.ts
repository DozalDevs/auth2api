import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import {
  ApiKeyEntry,
  Config,
  loadConfig,
  persistAccessRequests,
  persistApiKeys,
  persistCatalog,
} from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";

const ADMIN = "sk-admin-0123456789abcdef";
const LEO = "sk-leo-admin-0123456789abcdef";
const MARIA = "sk-maria-0123456789abcdef";
const OMAR = "sk-omar-0123456789abcdef";
const START = Date.parse("2026-10-30T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function entries(): ApiKeyEntry[] {
  return [
    { name: "boss", key: ADMIN, models: ["*"], admin: true },
    { name: "leo", key: LEO, models: ["*"], admin: true },
    { name: "maria", key: MARIA, models: ["@standard"] },
    { name: "omar", key: OMAR, models: ["gpt-6-luna"] },
  ];
}

async function startApp(t: test.TestContext) {
  const clock = { t: START };
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "requests-http-"));
  const configPath = path.join(authDir, "config.yaml");
  const models = [
    { id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" as const },
    { id: "gpt-6-sol", name: "GPT-6 Sol", access: "on_request" as const },
    { id: "gpt-6-astra", name: "GPT-6 Astra", access: "on_request" as const },
  ];
  fs.writeFileSync(configPath, yaml.dump({ "api-keys": entries(), models }));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": entries(),
    models,
    "body-limit": "1mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    stats: { enabled: false },
    debug: "off",
  };
  const app = createServer(config, buildRegistry(authDir), undefined, {
    persistKeys: persistApiKeys(configPath),
    persistCatalog: persistCatalog(configPath),
    persistRequests: persistAccessRequests(configPath),
    now: () => clock.t,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => {
    server.close();
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (
    method: string,
    p: string,
    key: string | null,
    body?: unknown,
  ) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
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
  const chat = (key: string, model: string) =>
    call("POST", "/v1/chat/completions", key, {
      model,
      messages: [{ role: "user", content: "hi" }],
    });
  return { call, chat, clock, configPath, authDir };
}

test("a key made without a model list can use every standard model and nothing on request", async (t) => {
  const { call, chat } = await startApp(t);
  const made = await call("POST", "/admin/keys", ADMIN, { name: "newbie" });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.models, ["@standard"]);
  const key = made.body.key as string;

  const list = await call("GET", "/setup/models", key);
  assert.match(list.text, /^gpt-6-luna\tallowed\t/m);
  assert.match(list.text, /^gpt-6-sol\ton_request\t/m);
  assert.equal(
    (await chat(key, "gpt-6-sol")).body.error.type,
    "model_not_allowed",
  );
  assert.notEqual(
    (await chat(key, "gpt-6-luna")).body?.error?.type,
    "model_not_allowed",
  );

  const explicit = await call("POST", "/admin/keys", ADMIN, {
    name: "picky",
    models: ["gpt-6-sol"],
  });
  assert.deepEqual(
    explicit.body.models,
    ["gpt-6-sol"],
    "an explicit list is kept as given",
  );
});

test("a request needs a reason and a real model the key does not already have", async (t) => {
  const { call } = await startApp(t);
  const ask = (body: unknown, key = MARIA) =>
    call("POST", "/access-requests", key, body);

  for (const bad of [undefined, "", "   "]) {
    const r = await ask({ model: "gpt-6-sol", reason: bad });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /reason is required/);
  }
  assert.equal(
    (await ask({ model: "gpt-6-sol", reason: "x".repeat(501) })).status,
    400,
  );
  assert.equal(
    (await ask({ reason: "need it" })).status,
    400,
    "a model is required",
  );
  assert.equal(
    (await ask({ model: "not-a-model", reason: "need it" })).status,
    400,
  );
  assert.equal(
    (await ask({ model: "gpt-6-luna", reason: "need it" })).status,
    409,
    "maria already has every standard model",
  );
  assert.equal(
    (await ask({ model: "gpt-6-sol", reason: "need it", hours: 0 })).status,
    400,
  );
  assert.equal(
    (await ask({ model: "gpt-6-sol", reason: "need it", hours: 200 })).status,
    400,
  );

  const ok = await ask({
    model: "gpt-6-sol",
    reason: "  review the redesign  ",
    hours: 2,
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.status, "pending");
  assert.equal(
    ok.body.reason,
    "review the redesign",
    "the reason is kept, trimmed",
  );
  assert.equal(ok.body.requested_minutes, 120);
  assert.deepEqual(ok.body.models, ["gpt-6-sol"]);

  const dup = await ask({ model: "gpt-6-sol", reason: "again" });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error.message, /already have a pending request/);

  assert.equal((await call("POST", "/access-requests", null, {})).status, 401);
});

test("ask, approve, use it, and watch it end on its own", async (t) => {
  const { call, chat, clock } = await startApp(t);
  const denied = await chat(MARIA, "gpt-6-astra");
  assert.equal(denied.status, 403);
  assert.match(denied.body.error.message, /POST \/access-requests/);

  const asked = await call("POST", "/access-requests", MARIA, {
    models: ["gpt-6-astra"],
    reason: "dashboard redesign",
    hours: 4,
  });
  assert.equal(asked.status, 201);
  const id = asked.body.id as string;
  assert.equal(
    (await chat(MARIA, "gpt-6-astra")).status,
    403,
    "asking does not open anything",
  );

  const waiting = await call("GET", "/admin/access-requests", LEO);
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.pending, 1);
  assert.equal(waiting.body.requests[0].key, "maria");
  assert.equal(waiting.body.requests[0].reason, "dashboard redesign");

  const approved = await call(
    "POST",
    `/admin/access-requests/${id}/approve`,
    LEO,
    {
      minutes: 60,
      note: "ok, but only an hour",
    },
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "approved");
  assert.equal(approved.body.decided_by, "leo");
  assert.equal(approved.body.decision_note, "ok, but only an hour");
  assert.equal(
    approved.body.seconds_left,
    3600,
    "the approver's time wins over the asked time",
  );

  const after = await chat(MARIA, "gpt-6-astra");
  assert.notEqual(
    after.body?.error?.type,
    "model_not_allowed",
    "it works the moment it is approved",
  );

  const keys = await call("GET", "/admin/keys", LEO);
  const maria = keys.body.keys.find((k: any) => k.name === "maria");
  assert.equal(maria.grants.length, 1);
  assert.deepEqual(maria.grants[0].models, ["gpt-6-astra"]);
  assert.equal(
    maria.grants[0].note,
    "dashboard redesign",
    "the grant carries the reason",
  );

  const mine = await call("GET", "/access-requests", MARIA);
  assert.equal(mine.body.requests[0].status, "approved");
  assert.equal(mine.body.requests[0].seconds_left, 3600);

  clock.t = START + HOUR;
  const ended = await chat(MARIA, "gpt-6-astra");
  assert.equal(ended.status, 403);
  assert.equal(ended.body.error.code, "grant_expired");

  const twice = await call(
    "POST",
    `/admin/access-requests/${id}/approve`,
    ADMIN,
    {},
  );
  assert.equal(twice.status, 409);
  assert.match(twice.body.error.message, /already approved by leo/);
  assert.equal(
    (await call("POST", `/admin/access-requests/${id}/reject`, ADMIN, {}))
      .status,
    409,
  );
});

test("a rejected request opens nothing, tells the asker why, and can be asked again", async (t) => {
  const { call, chat } = await startApp(t);
  const asked = await call("POST", "/access-requests", OMAR, {
    model: "gpt-6-sol",
    reason: "just curious",
  });
  assert.equal(
    asked.body.requested_minutes,
    240,
    "four hours when no time is given",
  );
  const rejected = await call(
    "POST",
    `/admin/access-requests/${asked.body.id}/reject`,
    ADMIN,
    {
      note: "use luna for that",
    },
  );
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.status, "rejected");
  assert.equal(rejected.body.decided_by, "boss");

  assert.equal((await chat(OMAR, "gpt-6-sol")).status, 403);
  const mine = await call("GET", "/access-requests", OMAR);
  assert.equal(mine.body.requests[0].status, "rejected");
  assert.equal(mine.body.requests[0].decision_note, "use luna for that");
  const keys = await call("GET", "/admin/keys", ADMIN);
  assert.deepEqual(
    keys.body.keys.find((k: any) => k.name === "omar").grants,
    [],
  );

  const again = await call("POST", "/access-requests", OMAR, {
    model: "gpt-6-sol",
    reason: "I do need it for the benchmark",
  });
  assert.equal(
    again.status,
    201,
    "a rejection does not block a better-argued second try",
  );
});

test("only admins decide, people only see their own requests, and only the asker can cancel", async (t) => {
  const { call } = await startApp(t);
  const a = await call("POST", "/access-requests", MARIA, {
    model: "gpt-6-sol",
    reason: "r1",
  });
  const b = await call("POST", "/access-requests", OMAR, {
    model: "gpt-6-astra",
    reason: "r2",
  });

  for (const route of ["approve", "reject"]) {
    const r = await call(
      "POST",
      `/admin/access-requests/${a.body.id}/${route}`,
      MARIA,
      {},
    );
    assert.equal(r.status, 403, `a normal key cannot ${route}`);
  }
  assert.equal(
    (await call("GET", "/admin/access-requests", MARIA)).status,
    403,
  );

  const mine = await call("GET", "/access-requests", MARIA);
  assert.deepEqual(
    mine.body.requests.map((r: any) => r.id),
    [a.body.id],
  );

  assert.equal(
    (await call("DELETE", `/access-requests/${b.body.id}`, MARIA)).status,
    404,
  );
  const cancelled = await call(
    "DELETE",
    `/access-requests/${a.body.id}`,
    MARIA,
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(
    (
      await call(
        "POST",
        `/admin/access-requests/${a.body.id}/approve`,
        ADMIN,
        {},
      )
    ).status,
    409,
    "a cancelled request cannot be approved",
  );
  assert.equal(
    (await call("POST", "/admin/access-requests/deadbeef/approve", ADMIN, {}))
      .status,
    404,
  );

  const pending = await call("GET", "/admin/access-requests", ADMIN);
  assert.deepEqual(
    pending.body.requests.map((r: any) => r.id),
    [b.body.id],
  );
  const everything = await call(
    "GET",
    "/admin/access-requests?status=all",
    ADMIN,
  );
  assert.equal(everything.body.requests.length, 2);
});

test("requests survive a restart and old decided ones are dropped after 30 days", async (t) => {
  const { call, clock, configPath } = await startApp(t);
  const a = await call("POST", "/access-requests", MARIA, {
    model: "gpt-6-sol",
    reason: "keep me",
  });
  const b = await call("POST", "/access-requests", OMAR, {
    model: "gpt-6-astra",
    reason: "old news",
  });
  await call("POST", `/admin/access-requests/${b.body.id}/reject`, ADMIN, {});

  const saved = loadConfig(configPath)["access-requests"]!;
  assert.deepEqual(
    saved.map((r) => r.id).sort(),
    [a.body.id, b.body.id].sort(),
  );
  assert.equal(saved.find((r) => r.id === a.body.id)!.reason, "keep me");
  assert.equal(saved.find((r) => r.id === b.body.id)!.status, "rejected");

  clock.t = START + 31 * DAY;
  await call("POST", "/access-requests", OMAR, {
    model: "gpt-6-sol",
    reason: "fresh",
  });
  const left = loadConfig(configPath)["access-requests"]!;
  assert.equal(
    left.some((r) => r.id === b.body.id),
    false,
    "the old rejection is gone",
  );
  assert.equal(
    left.some((r) => r.id === a.body.id),
    true,
    "a request still waiting is never dropped",
  );
});

test("a config with a request that has no reason is refused at start", async (t) => {
  const { configPath } = await startApp(t);
  const file = yaml.load(fs.readFileSync(configPath, "utf8")) as any;
  file["access-requests"] = [
    {
      id: "0a1b2c3d",
      key: "maria",
      models: ["gpt-6-sol"],
      minutes: 60,
      status: "pending",
      "requested-at": "2026-10-30T12:00:00Z",
    },
  ];
  fs.writeFileSync(configPath, yaml.dump(file));
  assert.throws(() => loadConfig(configPath), /reason is required/);
});
