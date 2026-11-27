import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import {
  Config,
  loadConfig,
  persistApiKeys,
  persistGoGuard,
} from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { GoGuard, GoGuardConfig } from "../src/go-guard/guard";

const NOW = Date.parse("2099-01-07T12:00:00Z"); // a Wednesday

function guard(over: Partial<GoGuardConfig> = {}) {
  return new GoGuard(
    {
      enabled: true,
      "guarded-keys": ["ai-employee-dev"],
      "ask-whom": "finicky-cat (8aa4f5f)",
      standing: [
        { name: "platform", "caller-prefix": "prod/" },
        {
          name: "CI",
          "caller-prefix": "dev/dozaldevs-app@vm",
          "weekly-cap": 2,
        },
        { name: "Sofia", key: "Sofia", "weekly-cap": 1 },
      ],
      "go-aheads": [
        { agent: "c92fd7e", until: "2099-01-07T13:00:00Z", cap: 2 },
      ],
      ...over,
    },
    { now: () => NOW },
  );
}

test("a gate or check run on the shared key with no go-ahead is refused, naming who to ask", () => {
  const v = guard().check(
    "ai-employee-dev",
    "dev/site-edit-mode@ai-employee-pool-abc123",
  );
  assert.equal(v.allow, false);
  assert.ok(!v.allow && v.status === 403);
  assert.match(!v.allow ? v.message : "", /finicky-cat \(8aa4f5f\)/);
  assert.equal(guard().check("ai-employee-dev", undefined).allow, false);
});

test("a live go-ahead lets calls through up to its cap, then refuses", () => {
  const g = guard();
  const caller = "dev/x@h/go:c92fd7e/org:5";
  assert.equal(g.check("ai-employee-dev", caller).allow, true);
  assert.equal(g.check("ai-employee-dev", caller).allow, true);
  const third = g.check("ai-employee-dev", caller);
  assert.ok(!third.allow && third.status === 429);
  assert.equal(g.list()["go-aheads"][0].used, 2);
});

test("an ended or unknown go-ahead is refused", () => {
  const ended = guard({
    "go-aheads": [{ agent: "old", until: "2099-01-07T11:00:00Z", cap: 9 }],
  });
  assert.match(
    String((ended.check("ai-employee-dev", "x/go:old") as any).message),
    /ended/,
  );
  assert.match(
    String((guard().check("ai-employee-dev", "x/go:nobody") as any).message),
    /no go-ahead named "nobody"/,
  );
});

test("standing go-aheads: platform uncapped, CI and teammates capped per week", () => {
  const g = guard();
  for (let i = 0; i < 50; i++)
    assert.equal(
      g.check("ai-employee-dev", "prod/ai-employees-oregon/org:5").allow,
      true,
    );
  assert.equal(
    g.check("ai-employee-dev", "dev/dozaldevs-app@vm12ab34/org:1").allow,
    true,
  );
  assert.equal(
    g.check("ai-employee-dev", "dev/dozaldevs-app@vm99zz99/org:1").allow,
    true,
  );
  assert.equal(
    g.check("ai-employee-dev", "dev/dozaldevs-app@vm12ab34/org:1").allow,
    false,
  );
  assert.equal(g.check("Sofia", undefined).allow, true);
  assert.equal(g.check("Sofia", undefined).allow, false);
  assert.equal(
    g.check("Arturo", undefined).allow,
    true,
    "a person's own key with no entry is not guarded",
  );
});

test("the guard does nothing when switched off", () => {
  assert.equal(
    guard({ enabled: false }).check("ai-employee-dev", undefined).allow,
    true,
  );
});

test("the relay refuses a guarded call before it reaches a model, and the admin call gives a go-ahead that persists", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-goguard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const KEY = "sk-dev-0123456789abcdef";
  const ADMIN = "sk-admin-0123456789abcdef";
  const configPath = path.join(dir, "config.yaml");
  fs.writeFileSync(
    configPath,
    yaml.dump({
      port: 1,
      "auth-dir": dir,
      "api-keys": [
        { name: "ai-employee-dev", key: KEY, models: ["*"] },
        { name: "boss", key: ADMIN, models: ["*"], admin: true },
      ],
      models: [{ id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" }],
      "go-guard": {
        enabled: true,
        "guarded-keys": ["ai-employee-dev"],
        "ask-whom": "finicky-cat (8aa4f5f)",
      },
    }),
  );
  const config: Config = {
    ...loadConfig(configPath),
    host: "127.0.0.1",
    port: 0,
    stats: { enabled: false },
  };
  const app = createServer(config, buildRegistry(dir), undefined, {
    persistKeys: persistApiKeys(configPath),
    persistGoGuard: persistGoGuard(configPath),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (caller: string) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        "x-relay-caller": caller,
      },
      body: JSON.stringify({
        model: "gpt-6-luna",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

  const refused = await call("dev/some-gate@ai-employee-pool-abc123");
  assert.equal(refused.status, 403);
  const body = (await refused.json()) as any;
  assert.equal(body.error.type, "go_ahead_required");

  const give = await fetch(`${base}/admin/go-guard/go-aheads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      agent: "c92fd7e",
      until: "2099-01-01T00:00:00Z",
      cap: 5,
    }),
  });
  assert.equal(give.status, 200);
  const passed = await call("dev/x@h/go:c92fd7e");
  assert.notEqual(passed.status, 403, "a go-ahead call goes past the guard");
  await passed.text();

  const saved = yaml.load(fs.readFileSync(configPath, "utf8")) as any;
  assert.equal(saved["go-guard"]["go-aheads"][0].agent, "c92fd7e");
  const listed = (await (
    await fetch(`${base}/admin/go-guard`, {
      headers: { authorization: `Bearer ${ADMIN}` },
    })
  ).json()) as any;
  assert.equal(listed["go-aheads"][0].used, 1);
});
