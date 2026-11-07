import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { ApiKeyEntry, Config, persistApiKeys } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { AccountManager } from "../src/accounts/manager";
import { TokenData } from "../src/auth/types";
import {
  CodexUsageMonitor,
  parseCodexUsage,
} from "../src/upstream/codex-usage";

const ADMIN = "sk-admin-0123456789abcdef";
const MEMBER = "sk-member-0123456789abcdef";

const WEEK = 604_800;
const FIVE_HOURS = 18_000;

function makeConfig(authDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": [],
    models: [],
    "body-limit": "1mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    stats: { enabled: false },
    debug: "off",
  } as Config;
}

function token(email: string, provider: "codex" | "anthropic"): TokenData {
  return {
    accessToken: `access-${email}`,
    refreshToken: "secret-refresh-token",
    email,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountUuid: `acct-${email}`,
    provider,
    planType: "plus",
  };
}

function payload(weeklyPct: number, fiveHourPct: number, resetAt: number) {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: fiveHourPct,
        limit_window_seconds: FIVE_HOURS,
        reset_after_seconds: 100,
        reset_at: resetAt - 1000,
      },
      secondary_window: {
        used_percent: weeklyPct,
        limit_window_seconds: WEEK,
        reset_after_seconds: 1000,
        reset_at: resetAt,
      },
    },
  };
}

function codexManager(t: test.TestContext, emails: string[]) {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-usage-"));
  t.after(() => fs.rmSync(authDir, { recursive: true, force: true }));
  const manager = new AccountManager(authDir, {
    provider: "codex",
    refresh: async () => {
      throw new Error("no refresh in this test");
    },
  });
  for (const e of emails) manager.addAccount(token(e, "codex"));
  return { authDir, manager };
}

// ── parseCodexUsage ──────────────────────────────────────────────

test("parseCodexUsage reads the weekly and 5h windows by their length, not their slot", () => {
  const parsed = parseCodexUsage(payload(72, 10, 2_000_000_000));
  assert.deepEqual(parsed, {
    weeklyUsedPercent: 72,
    weeklyResetsAt: new Date(2_000_000_000 * 1000).toISOString(),
    fiveHourUsedPercent: 10,
    fiveHourResetsAt: new Date((2_000_000_000 - 1000) * 1000).toISOString(),
  });

  // Plans with a weekly window only put it in primary_window.
  const weeklyOnly = parseCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: 41,
        limit_window_seconds: WEEK,
        reset_after_seconds: 5,
        reset_at: 2_000_000_000,
      },
      secondary_window: null,
    },
  });
  assert.equal(weeklyOnly?.weeklyUsedPercent, 41);
  assert.equal(weeklyOnly?.fiveHourUsedPercent, null);
  assert.equal(weeklyOnly?.fiveHourResetsAt, null);
});

test("parseCodexUsage answers null for anything it does not recognise", () => {
  assert.equal(parseCodexUsage(null), null);
  assert.equal(parseCodexUsage("<html>blocked</html>"), null);
  assert.equal(parseCodexUsage({}), null);
  assert.equal(parseCodexUsage({ rate_limit: null }), null);
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: {} } }), null);
  // used_percent as text is a changed shape, not a number to guess at
  assert.equal(
    parseCodexUsage({
      rate_limit: {
        primary_window: {
          used_percent: "72",
          limit_window_seconds: WEEK,
          reset_at: 1,
        },
      },
    }),
    null,
  );
});

// ── CodexUsageMonitor ────────────────────────────────────────────

const MIN = 60_000;

function monitorFor(
  manager: AccountManager,
  config: Config,
  fetchImpl: typeof fetch,
  clock: { now: number },
) {
  return new CodexUsageMonitor({
    manager,
    config,
    fetchImpl,
    minIntervalMs: 5 * MIN,
    now: () => clock.now,
  });
}

test("the monitor calls wham/usage with the account's own bearer token and account id", async (t) => {
  const { authDir, manager } = codexManager(t, ["a@example.com"]);
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    seen.push({ url: String(input), headers: init.headers });
    return new Response(JSON.stringify(payload(72, 10, 2_000_000_000)), {
      status: 200,
    });
  }) as typeof fetch;
  const monitor = monitorFor(manager, makeConfig(authDir), fetchImpl, {
    now: 1_000_000,
  });
  await monitor.tick();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(seen[0].headers.Authorization, "Bearer access-a@example.com");
  assert.equal(seen[0].headers["ChatGPT-Account-ID"], "acct-a@example.com");

  const [snap] = manager.getSnapshots() as any[];
  assert.equal(snap.weeklyUsedPercent, 72);
  assert.equal(
    snap.weeklyResetsAt,
    new Date(2_000_000_000 * 1000).toISOString(),
  );
  assert.equal(snap.fiveHourUsedPercent, 10);
});

test("at most one call per account per interval, however often the monitor ticks", async (t) => {
  const { authDir, manager } = codexManager(t, [
    "a@example.com",
    "b@example.com",
  ]);
  const calls: string[] = [];
  const fetchImpl = (async (_i: any, init: any) => {
    calls.push(init.headers.Authorization);
    return new Response(JSON.stringify(payload(10, 1, 2_000_000_000)), {
      status: 200,
    });
  }) as typeof fetch;
  const clock = { now: 1_000_000 };
  const monitor = monitorFor(manager, makeConfig(authDir), fetchImpl, clock);

  await monitor.tick();
  assert.equal(calls.length, 2); // one per account

  clock.now += 4 * MIN + 59_000;
  await monitor.tick();
  await monitor.tick();
  assert.equal(calls.length, 2); // still inside the interval

  clock.now += 2_000;
  await monitor.tick();
  assert.equal(calls.length, 4); // interval passed: one more each
});

test("a new account is picked up on the next tick without waiting out the others' interval", async (t) => {
  const { authDir, manager } = codexManager(t, ["a@example.com"]);
  const calls: string[] = [];
  const fetchImpl = (async (_i: any, init: any) => {
    calls.push(init.headers.Authorization);
    return new Response(JSON.stringify(payload(10, 1, 2_000_000_000)), {
      status: 200,
    });
  }) as typeof fetch;
  const clock = { now: 1_000_000 };
  const monitor = monitorFor(manager, makeConfig(authDir), fetchImpl, clock);
  await monitor.tick();
  manager.addAccount(token("b@example.com", "codex"));
  clock.now += MIN;
  await monitor.tick();
  assert.deepEqual(calls, [
    "Bearer access-a@example.com",
    "Bearer access-b@example.com",
  ]);
});

test("a failing or changed endpoint leaves the fields null, is not retried inside the interval, and never throws", async (t) => {
  const { authDir, manager } = codexManager(t, ["a@example.com"]);
  let calls = 0;
  let mode: "ok" | "500" | "html" | "throw" | "changed" = "ok";
  const fetchImpl = (async () => {
    calls++;
    if (mode === "throw") throw new Error("socket hang up");
    if (mode === "500") return new Response("boom", { status: 500 });
    if (mode === "html") return new Response("<html>", { status: 200 });
    if (mode === "changed")
      return new Response(JSON.stringify({ usage: { weekly: 0.5 } }), {
        status: 200,
      });
    return new Response(JSON.stringify(payload(72, 10, 2_000_000_000)), {
      status: 200,
    });
  }) as typeof fetch;
  const clock = { now: 1_000_000 };
  const monitor = monitorFor(manager, makeConfig(authDir), fetchImpl, clock);

  await monitor.tick();
  assert.equal((manager.getSnapshots()[0] as any).weeklyUsedPercent, 72);

  for (const failure of ["500", "html", "throw", "changed"] as const) {
    mode = failure;
    clock.now += 5 * MIN;
    const before = calls;
    await monitor.tick();
    await monitor.tick(); // a second tick right away must not call again
    assert.equal(calls, before + 1, `${failure}: exactly one attempt`);
    const snap = manager.getSnapshots()[0] as any;
    assert.equal(snap.weeklyUsedPercent, null, failure);
    assert.equal(snap.weeklyResetsAt, null, failure);
    assert.equal(snap.fiveHourUsedPercent, null, failure);
    assert.equal(snap.fiveHourResetsAt, null, failure);
    const status = manager.getStatuses()[0] as any;
    assert.equal(status.weeklyUsedPercent, null, failure);
  }

  // Recovery on the next interval.
  mode = "ok";
  clock.now += 5 * MIN;
  await monitor.tick();
  assert.equal((manager.getSnapshots()[0] as any).weeklyUsedPercent, 72);
});

test("a hung usage call is cut off by the timeout and does not stop later ticks", async (t) => {
  const { authDir, manager } = codexManager(t, ["a@example.com"]);
  const fetchImpl = ((_i: any, init: any) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  const monitor = new CodexUsageMonitor({
    manager,
    config: makeConfig(authDir),
    fetchImpl,
    minIntervalMs: 5 * MIN,
    timeoutMs: 20,
  });
  await monitor.tick();
  assert.equal((manager.getSnapshots()[0] as any).weeklyUsedPercent, null);
});

test("overlapping ticks share one pass instead of doubling the calls", async (t) => {
  const { authDir, manager } = codexManager(t, ["a@example.com"]);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fetchImpl = (async () => {
    calls++;
    await gate;
    return new Response(JSON.stringify(payload(5, 1, 2_000_000_000)), {
      status: 200,
    });
  }) as typeof fetch;
  const monitor = monitorFor(manager, makeConfig(authDir), fetchImpl, {
    now: 1_000_000,
  });
  const first = monitor.tick();
  const second = monitor.tick();
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

// ── the two routes ───────────────────────────────────────────────

async function startServer(t: test.TestContext) {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-usage-srv-"));
  t.after(() => fs.rmSync(authDir, { recursive: true, force: true }));
  const registry = buildRegistry(authDir);
  registry.get("codex").manager.addAccount(token("owner@example.com", "codex"));
  registry
    .get("anthropic")
    .manager.addAccount(token("claude@example.com", "anthropic"));
  const keys: ApiKeyEntry[] = [
    { name: "boss", key: ADMIN, models: ["*"], admin: true },
    { name: "member", key: MEMBER, models: ["*"] },
  ];
  const configPath = path.join(authDir, "config.yaml");
  fs.writeFileSync(configPath, yaml.dump({ port: 1, "api-keys": keys }));
  const config = { ...makeConfig(authDir), "api-keys": keys };
  const app = createServer(config, registry, undefined, {
    persistKeys: persistApiKeys(configPath),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => server.close());
  const port = (server.address() as any).port;
  const get = async (p: string, key: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    return res.json() as Promise<any>;
  };
  return { registry, authDir, config, get };
}

test("/admin/accounts and /v1/status show usage as null until it is known, then the real numbers", async (t) => {
  const { registry, config, get } = await startServer(t);
  const codex = registry.get("codex").manager;

  const unknownAdmin = await get("/admin/accounts", ADMIN);
  const unknownAcct = unknownAdmin.providers.codex.accounts[0];
  assert.equal(unknownAcct.weeklyUsedPercent, null);
  assert.equal(unknownAcct.weeklyResetsAt, null);
  assert.equal(unknownAcct.fiveHourUsedPercent, null);
  assert.equal(unknownAcct.fiveHourResetsAt, null);

  const fetchImpl = (async () =>
    new Response(JSON.stringify(payload(86, 30, 2_000_000_000)), {
      status: 200,
    })) as typeof fetch;
  await new CodexUsageMonitor({
    manager: codex,
    config,
    fetchImpl,
    minIntervalMs: 5 * MIN,
  }).tick();

  const admin = await get("/admin/accounts", ADMIN);
  const acct = admin.providers.codex.accounts[0];
  assert.equal(acct.weeklyUsedPercent, 86);
  assert.equal(
    acct.weeklyResetsAt,
    new Date(2_000_000_000 * 1000).toISOString(),
  );
  assert.equal(acct.fiveHourUsedPercent, 30);
  // Other providers' accounts carry no codex usage fields at all.
  assert.ok(!("weeklyUsedPercent" in admin.providers.anthropic.accounts[0]));

  const status = await get("/v1/status", MEMBER);
  const s = status.providers.codex.accounts[0];
  assert.equal(s.weeklyUsedPercent, 86);
  assert.equal(s.weeklyResetsAt, acct.weeklyResetsAt);
  assert.equal(s.fiveHourUsedPercent, 30);
  assert.ok(!("weeklyUsedPercent" in status.providers.anthropic.accounts[0]));
});

test("reading the routes never calls upstream, so a dead usage endpoint cannot slow them", async (t) => {
  const { get } = await startServer(t);
  const realFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    if (String(input).includes("chatgpt.com")) {
      upstreamCalls++;
      throw new Error("chatgpt.com must not be called from a route");
    }
    return realFetch(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  await get("/admin/accounts", ADMIN);
  await get("/v1/status", MEMBER);
  assert.equal(upstreamCalls, 0);
});
