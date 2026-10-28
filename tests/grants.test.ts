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
  persistApiKeys,
  persistCatalog,
} from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { KeyStore, KeyStoreError } from "../src/keys/store";
import { DEFAULT_CATALOG, ModelCatalog } from "../src/models/catalog";

const ADMIN = "sk-admin-0123456789abcdef";
const MARIA = "sk-maria-0123456789abcdef";
const START = Date.parse("2026-10-28T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function entries(): ApiKeyEntry[] {
  return [
    { name: "boss", key: ADMIN, models: ["*"], admin: true },
    { name: "maria", key: MARIA, models: ["gpt-6-luna"] },
  ];
}

function store(clock: { t: number }, persist?: (e: ApiKeyEntry[]) => void) {
  return new KeyStore(entries(), {
    statsEnabled: false,
    now: () => clock.t,
    persist,
  });
}

test("a grant adds models until its end and then stops, down to the millisecond", () => {
  const clock = { t: START };
  const s = store(clock);
  const maria = () => s.authenticate(MARIA)!;
  assert.equal(s.allows(maria(), "gpt-6-astra"), false);

  const { grant } = s.grant(
    "maria",
    { models: ["gpt-6-astra"], minutes: 120 },
    "boss",
  );
  assert.equal(grant.until, new Date(START + 2 * HOUR).toISOString());
  assert.equal(s.allows(s.authenticate(MARIA)!, "gpt-6-astra"), true);
  assert.equal(
    s.allows(s.authenticate(MARIA)!, "gpt-6-sol"),
    false,
    "only the granted model",
  );
  assert.equal(
    s.allows(s.authenticate(MARIA)!, "gpt-6-luna"),
    true,
    "the base list is untouched",
  );

  clock.t = START + 2 * HOUR - 1;
  assert.equal(s.allows(s.authenticate(MARIA)!, "gpt-6-astra"), true);
  clock.t = START + 2 * HOUR;
  assert.equal(s.allows(s.authenticate(MARIA)!, "gpt-6-astra"), false);
  assert.equal(s.allows(s.authenticate(MARIA)!, "gpt-6-luna"), true);
});

test("a grant for an alias covers the model it resolves to, and nothing broader", () => {
  const clock = { t: START };
  const s = store(clock);
  s.grant("maria", { models: ["opus"], minutes: 60 }, "boss");
  const maria = s.authenticate(MARIA)!;
  assert.equal(s.allows(maria, "claude-opus-4-7"), true);
  assert.equal(s.allows(maria, "opus"), true);
  assert.equal(s.allows(maria, "sonnet"), false);
});

test("several grants stack, can be revoked one by one, and revoking takes effect at once", () => {
  const clock = { t: START };
  const s = store(clock);
  const a = s.grant(
    "maria",
    { models: ["gpt-6-astra"], minutes: 60 },
    "boss",
  ).grant;
  const b = s.grant(
    "maria",
    { models: ["gpt-6-sol"], minutes: 240, note: "UI sprint" },
    "boss",
  ).grant;
  let maria = s.authenticate(MARIA)!;
  assert.deepEqual(s.allowedIds(maria).sort(), [
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
  ]);
  assert.equal(b.note, "UI sprint");

  s.revokeGrant("maria", a.id, "boss");
  maria = s.authenticate(MARIA)!;
  assert.equal(s.allows(maria, "gpt-6-astra"), false);
  assert.equal(s.allows(maria, "gpt-6-sol"), true);
  assert.throws(
    () => s.revokeGrant("maria", a.id, "boss"),
    (e: any) => e instanceof KeyStoreError && e.status === 404,
  );
  assert.throws(
    () => s.revokeGrant("ghost", a.id, "boss"),
    (e: any) => e.status === 404,
  );
});

test("grant input is validated: models, duration limits and note", () => {
  const s = store({ t: START });
  const bad = (input: any, status = 400) =>
    assert.throws(
      () => s.grant("maria", input, "boss"),
      (e: any) => e instanceof KeyStoreError && e.status === status,
      JSON.stringify(input),
    );
  bad({ models: [], minutes: 60 });
  bad({ models: ["*"], minutes: 60 });
  bad({ models: ["bad model!"], minutes: 60 });
  bad({ models: "gpt-6-astra", minutes: 60 });
  bad({ models: ["gpt-6-astra"], minutes: 0 });
  bad({ models: ["gpt-6-astra"], minutes: 10_081 });
  bad({ models: ["gpt-6-astra"], minutes: 1.5 });
  bad({ models: ["gpt-6-astra"], minutes: Number.NaN });
  bad({ models: ["gpt-6-astra"], minutes: 60, note: "x".repeat(201) });
  assert.throws(
    () => s.grant("ghost", { models: ["gpt-6-astra"], minutes: 60 }, "boss"),
    (e: any) => e.status === 404,
  );
  assert.doesNotThrow(() =>
    s.grant("maria", { models: ["gpt-6-astra"], minutes: 1 }, "boss"),
  );
  assert.doesNotThrow(() =>
    s.grant("maria", { models: ["gpt-6-astra"], minutes: 10_080 }, "boss"),
  );
});

test("ended grants are remembered for a day for the error message, then dropped", () => {
  const clock = { t: START };
  const written: ApiKeyEntry[][] = [];
  const s = store(clock, (e) => written.push(e));
  s.grant("maria", { models: ["gpt-6-astra"], minutes: 60 }, "boss");

  clock.t = START + HOUR + 30 * MIN;
  const maria = s.authenticate(MARIA)!;
  assert.equal(s.activeGrants(maria).length, 0);
  assert.equal(s.endedGrants(maria).length, 1);
  assert.equal(s.endedGrantFor(maria, "gpt-6-astra")?.models[0], "gpt-6-astra");
  assert.equal(s.endedGrantFor(maria, "gpt-6-sol"), undefined);

  clock.t = START + HOUR + 25 * HOUR;
  assert.equal(
    s.endedGrants(s.authenticate(MARIA)!).length,
    0,
    "past a day it is no longer reported",
  );
  s.update("maria", { disabled: false });
  assert.equal(
    s.authenticate(MARIA)!.grants,
    undefined,
    "and the next save drops it from the file",
  );
  assert.equal(
    written.at(-1)!.find((e) => e.name === "maria")!.grants,
    undefined,
  );
});

test("editing a key keeps its grants, and a failed save leaves the live grants alone", () => {
  const clock = { t: START };
  let fail = false;
  const s = store(clock, () => {
    if (fail) throw new Error("disk full");
  });
  s.grant("maria", { models: ["gpt-6-astra"], minutes: 60 }, "boss");
  s.update("maria", {
    "daily-token-limit": undefined,
    models: ["gpt-6-luna", "gpt-6-sol"],
  });
  assert.equal(s.allows(s.authenticate(MARIA)!, "gpt-6-astra"), true);

  fail = true;
  assert.throws(
    () => s.grant("maria", { models: ["gpt-6-sol"], minutes: 60 }, "boss"),
    (e: any) => e.status === 500,
  );
  assert.equal(s.authenticate(MARIA)!.grants!.length, 1);
});

test("grants and the model list survive a save and a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grants-cfg-"));
  const file = path.join(dir, "config.yaml");
  try {
    fs.writeFileSync(file, yaml.dump({ "api-keys": entries() }));
    const clock = { t: Date.now() };
    const s = new KeyStore(loadConfig(file)["api-keys"], {
      statsEnabled: false,
      now: () => clock.t,
      persist: persistApiKeys(file),
    });
    s.grant(
      "maria",
      { models: ["gpt-6-astra"], minutes: 600, note: "demo" },
      "boss",
    );
    const catalog = new ModelCatalog(undefined, {
      persist: persistCatalog(file),
    });
    catalog.upsert({
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      access: "on_request",
    });

    const reloaded = loadConfig(file);
    const maria = reloaded["api-keys"].find((k) => k.name === "maria")!;
    assert.equal(maria.grants!.length, 1);
    assert.equal(maria.grants![0].note, "demo");
    assert.equal(
      reloaded.models!.some(
        (m) => m.id === "claude-opus-5-5" && m.access === "on_request",
      ),
      true,
    );
    assert.equal(
      reloaded.models!.length,
      DEFAULT_CATALOG.length + 1,
      "the built-in list was saved with the addition",
    );
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("config rejects malformed grants and models", () => {
  const load = (extra: object) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grants-bad-"));
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(
      file,
      yaml.dump({ "api-keys": entries().map((e) => ({ ...e })), ...extra }),
    );
    return { run: () => loadConfig(file), dir };
  };
  const t = load({ models: [{ id: "a b", name: "x" }] });
  assert.throws(t.run, /model name/);
  const t2 = load({
    models: [
      { id: "a", name: "A" },
      { id: "A", name: "B" },
    ],
  });
  assert.throws(t2.run, /duplicate/);
  const t3 = load({ models: [{ id: "a", name: "A", access: "free" }] });
  assert.throws(t3.run, /access must be/);
  const bad = entries();
  (bad[1] as any).grants = [
    {
      id: "nothex",
      models: ["gpt-6-astra"],
      until: "2026-10-28T14:00:00Z",
      "granted-at": "2026-10-28T12:00:00Z",
    },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grants-bad2-"));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yaml.dump({ "api-keys": bad }));
  assert.throws(() => loadConfig(file), /id must be 8 hex/);
  for (const d of [t.dir, t2.dir, t3.dir, dir])
    fs.rmSync(d, { recursive: true, force: true });
});

async function startApp(t: test.TestContext) {
  const clock = { t: START };
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "grants-http-"));
  const configPath = path.join(authDir, "config.yaml");
  fs.writeFileSync(configPath, yaml.dump({ "api-keys": entries() }));
  const config: Config = {
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
    stats: { enabled: false },
    debug: "off",
  };
  const app = createServer(config, buildRegistry(authDir), undefined, {
    persistKeys: persistApiKeys(configPath),
    persistCatalog: persistCatalog(configPath),
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
  return { call, chat, clock, configPath };
}

test("granting over HTTP: the model is refused, then allowed, then refused again with a clear reason", async (t) => {
  const { call, chat, clock } = await startApp(t);
  const before = await chat(MARIA, "gpt-6-astra");
  assert.equal(before.status, 403);
  assert.equal(before.body.error.type, "model_not_allowed");
  assert.match(
    before.body.error.message,
    /not enabled for this key\. Ask the engineering team for access/,
  );
  assert.equal(before.body.error.code, undefined);

  const made = await call("POST", "/admin/keys/maria/grants", ADMIN, {
    models: ["gpt-6-astra"],
    hours: 2,
    note: "hard UI task",
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.grant.seconds_left, 7200);
  assert.equal(made.body.grants.length, 1);

  const during = await chat(MARIA, "gpt-6-astra");
  assert.notEqual(
    during.body?.error?.type,
    "model_not_allowed",
    "now it gets past the allowlist",
  );

  clock.t = START + 2 * HOUR + 35 * MIN;
  const after = await chat(MARIA, "gpt-6-astra");
  assert.equal(after.status, 403);
  assert.equal(after.body.error.code, "grant_expired");
  assert.match(
    after.body.error.message,
    /temporary access to "gpt-6-astra" ended 35 minutes ago/,
  );

  const other = await chat(MARIA, "gpt-6-sol");
  assert.equal(
    other.body.error.code,
    undefined,
    "an unrelated model gets the plain message",
  );
});

test("the admin list shows active and just-ended grants with times", async (t) => {
  const { call, clock } = await startApp(t);
  await call("POST", "/admin/keys/maria/grants", ADMIN, {
    models: ["gpt-6-astra"],
    minutes: 240,
  });
  await call("POST", "/admin/keys/maria/grants", ADMIN, {
    models: ["gpt-6-sol"],
    minutes: 30,
  });
  clock.t = START + 45 * MIN;
  const list = await call("GET", "/admin/keys", ADMIN);
  const maria = list.body.keys.find((k: any) => k.name === "maria");
  assert.deepEqual(maria.models, ["gpt-6-luna"]);
  assert.deepEqual(
    maria.grants.map((g: any) => [g.models[0], g.seconds_left]),
    [["gpt-6-astra", (240 - 45) * 60]],
  );
  assert.deepEqual(
    maria.ended_grants.map((g: any) => [g.models[0], g.ended_seconds_ago]),
    [["gpt-6-sol", 15 * 60]],
  );
  assert.equal(JSON.stringify(list.body).includes(MARIA), false);
});

test("revoking a grant over HTTP cuts access immediately", async (t) => {
  const { call, chat } = await startApp(t);
  const made = await call("POST", "/admin/keys/maria/grants", ADMIN, {
    models: ["gpt-6-astra"],
    minutes: 120,
  });
  assert.notEqual(
    (await chat(MARIA, "gpt-6-astra")).body?.error?.type,
    "model_not_allowed",
  );
  const gone = await call(
    "DELETE",
    `/admin/keys/maria/grants/${made.body.grant.id}`,
    ADMIN,
  );
  assert.equal(gone.status, 200);
  assert.equal(gone.body.grants.length, 0);
  assert.equal((await chat(MARIA, "gpt-6-astra")).status, 403);
  assert.equal(
    (
      await call(
        "DELETE",
        `/admin/keys/maria/grants/${made.body.grant.id}`,
        ADMIN,
      )
    ).status,
    404,
  );
});

test("only admins can grant, and bad requests are rejected clearly", async (t) => {
  const { call } = await startApp(t);
  assert.equal(
    (
      await call("POST", "/admin/keys/maria/grants", MARIA, {
        models: ["gpt-6-astra"],
        minutes: 60,
      })
    ).status,
    403,
    "a member cannot grant themselves access",
  );
  assert.equal(
    (
      await call("POST", "/admin/keys/maria/grants", null, {
        models: ["gpt-6-astra"],
        minutes: 60,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call("POST", "/admin/keys/maria/grants", ADMIN, {
        models: ["gpt-6-astra"],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/admin/keys/maria/grants", ADMIN, {
        models: ["gpt-6-astra"],
        hours: 9999,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/admin/keys/maria/grants", ADMIN, {
        models: ["*"],
        minutes: 60,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/admin/keys/nobody/grants", ADMIN, {
        models: ["gpt-6-astra"],
        minutes: 60,
      })
    ).status,
    404,
  );
});

test("/setup/models lists what the key can use now, plus labelled on-request models", async (t) => {
  const { call, clock } = await startApp(t);
  const lines = (r: { text: string }) =>
    r.text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"));

  let r = await call("GET", "/setup/models", MARIA);
  assert.equal(r.status, 200);
  assert.deepEqual(
    lines(r),
    [["gpt-6-luna", "allowed", "GPT-6 Luna"]],
    "by default a restricted key sees only what it can use",
  );

  await call("POST", "/admin/models", ADMIN, {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    access: "on_request",
  });
  r = await call("GET", "/setup/models", MARIA);
  assert.deepEqual(lines(r), [
    ["gpt-6-luna", "allowed", "GPT-6 Luna"],
    ["gpt-6-astra", "on_request", "GPT-6 Astra (on request)"],
  ]);

  await call("POST", "/admin/keys/maria/grants", ADMIN, {
    models: ["gpt-6-astra"],
    minutes: 60,
  });
  r = await call("GET", "/setup/models", MARIA);
  assert.deepEqual(
    lines(r).find((l) => l[0] === "gpt-6-astra"),
    ["gpt-6-astra", "allowed", "GPT-6 Astra"],
  );

  clock.t = START + 2 * HOUR;
  r = await call("GET", "/setup/models", MARIA);
  assert.deepEqual(
    lines(r).find((l) => l[0] === "gpt-6-astra"),
    ["gpt-6-astra", "on_request", "GPT-6 Astra (on request)"],
  );

  const wide = await call("GET", "/setup/models", ADMIN);
  assert.equal(
    lines(wide).every((l) => l[1] === "allowed"),
    true,
    "a wildcard key can use everything listed",
  );
  assert.equal((await call("GET", "/setup/models", null)).status, 401);
  assert.equal(
    (await call("GET", "/setup/models", "sk-nope-0123456789abcdef")).status,
    403,
  );
});

test("a key's own models that the list does not know are still listed", async (t) => {
  const { call } = await startApp(t);
  await call("PATCH", "/admin/keys/maria", ADMIN, {
    models: ["gpt-6-luna", "mystery-model"],
  });
  const r = await call("GET", "/setup/models", MARIA);
  assert.match(r.text, /mystery-model\tallowed\tmystery-model/);
});

test("/v1/models includes granted models the providers do not report", async (t) => {
  const { call } = await startApp(t);
  assert.deepEqual(
    (await call("GET", "/v1/models", MARIA)).body.data.map((m: any) => m.id),
    ["gpt-6-luna"],
  );
  await call("POST", "/admin/keys/maria/grants", ADMIN, {
    models: ["gpt-6-astra"],
    minutes: 60,
  });
  assert.deepEqual(
    (await call("GET", "/v1/models", MARIA)).body.data
      .map((m: any) => m.id)
      .sort(),
    ["gpt-6-astra", "gpt-6-luna"],
  );
});

test("the model list is managed over HTTP and saved to the config file", async (t) => {
  const { call, configPath } = await startApp(t);
  const first = await call("GET", "/admin/models", ADMIN);
  assert.equal(first.body.source, "default");
  assert.equal(first.body.models.length, DEFAULT_CATALOG.length);

  const added = await call("POST", "/admin/models", ADMIN, {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    access: "on_request",
  });
  assert.equal(added.status, 201);
  const second = await call("GET", "/admin/models", ADMIN);
  assert.equal(second.body.source, "config");
  assert.equal(second.body.models.at(-1).id, "claude-opus-5-5");
  assert.equal(
    (yaml.load(fs.readFileSync(configPath, "utf-8")) as any).models.length,
    DEFAULT_CATALOG.length + 1,
  );

  const renamed = await call("POST", "/admin/models", ADMIN, {
    id: "CLAUDE-OPUS-5-5",
    name: "Opus 5.5",
    access: "standard",
  });
  assert.equal(renamed.status, 201);
  const third = await call("GET", "/admin/models", ADMIN);
  assert.equal(
    third.body.models.filter(
      (m: any) => m.id.toLowerCase() === "claude-opus-5-5",
    ).length,
    1,
    "same id replaces, never duplicates",
  );
  assert.equal(third.body.models.at(-1).access, "standard");

  assert.equal(
    (await call("DELETE", "/admin/models/claude-opus-5-5", ADMIN)).status,
    204,
  );
  assert.equal(
    (await call("DELETE", "/admin/models/claude-opus-5-5", ADMIN)).status,
    404,
  );
  assert.equal(
    (await call("POST", "/admin/models", ADMIN, { id: "bad id", name: "x" }))
      .status,
    400,
  );
  assert.equal(
    (await call("POST", "/admin/models", ADMIN, { id: "ok-id", name: "" }))
      .status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/admin/models", ADMIN, {
        id: "ok-id",
        name: "x",
        access: "free",
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("GET", "/admin/models", MARIA)).status,
    403,
    "members cannot read or change the list",
  );
  assert.equal(
    (await call("POST", "/admin/models", MARIA, { id: "ok-id", name: "x" }))
      .status,
    403,
  );
});
