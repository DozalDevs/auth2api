import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { AccountManager, AvailableAccount } from "../src/accounts/manager";
import { fetchCodexUsage, CodexUsage } from "../src/upstream/codex-usage";
import { TokenData } from "../src/auth/types";
import { ApiKeyEntry, Config, persistApiKeys } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";

const MIN = 60_000;
const WEEK = 604_800;
const FIVE_HOURS = 18_000;
const flush = () => new Promise<void>((r) => setImmediate(r));

function token(email = "owner@example.com"): TokenData {
  return {
    accessToken: "secret-access-token",
    refreshToken: "secret-refresh-token",
    email,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountUuid: "acct_123",
    provider: "codex",
  };
}

function newManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-"));
  const manager = new AccountManager(dir, {
    provider: "codex",
    refresh: async () => {
      throw new Error("no refresh in this test");
    },
  });
  manager.addAccount(token());
  return { manager, dir };
}

function usage(weeklyPct: number, resetsAt: string): CodexUsage {
  return {
    weekly: { usedPercent: weeklyPct, resetsAt },
    fiveHour: { usedPercent: 3, resetsAt: "2026-11-07T20:00:00.000Z" },
  };
}

// ── fetchCodexUsage: the call the Codex CLI's /status makes ────────────────

function account(): AvailableAccount {
  return {
    token: token(),
    deviceId: "d",
    accountUuid: "acct_123",
    provider: "codex",
    chatgptAccountId: "acct_123",
  };
}

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
      },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("fetchCodexUsage GETs wham/usage with the account's bearer token and account id", async () => {
  const { impl, calls } = fakeFetch(200, {
    rate_limit: {
      primary_window: {
        used_percent: 12,
        limit_window_seconds: FIVE_HOURS,
        reset_after_seconds: 100,
        reset_at: 1_794_000_000,
      },
      secondary_window: {
        used_percent: 71,
        limit_window_seconds: WEEK,
        reset_after_seconds: 200,
        reset_at: 1_794_400_000,
      },
    },
  });
  const got = await fetchCodexUsage(account(), impl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(calls[0].headers.Authorization, "Bearer secret-access-token");
  assert.equal(calls[0].headers["ChatGPT-Account-ID"], "acct_123");
  assert.deepEqual(got, {
    fiveHour: {
      usedPercent: 12,
      resetsAt: new Date(1_794_000_000_000).toISOString(),
    },
    weekly: {
      usedPercent: 71,
      resetsAt: new Date(1_794_400_000_000).toISOString(),
    },
  });
});

test("fetchCodexUsage tells windows apart by length, not by primary/secondary", async () => {
  // A free plan reports only the weekly window, as primary.
  const { impl } = fakeFetch(200, {
    rate_limit: {
      primary_window: {
        used_percent: 40,
        limit_window_seconds: WEEK,
        reset_at: 1_794_400_000,
      },
      secondary_window: null,
    },
  });
  const got = await fetchCodexUsage(account(), impl);
  assert.equal(got.weekly?.usedPercent, 40);
  assert.equal(got.fiveHour, null);
});

test("fetchCodexUsage throws on HTTP errors and on an unrecognised body", async () => {
  await assert.rejects(fetchCodexUsage(account(), fakeFetch(401, "no").impl));
  await assert.rejects(fetchCodexUsage(account(), fakeFetch(404, "gone").impl));
  await assert.rejects(
    fetchCodexUsage(account(), fakeFetch(200, "<html>").impl),
  );
  await assert.rejects(
    fetchCodexUsage(account(), fakeFetch(200, { something: "else" }).impl),
  );
  await assert.rejects(
    fetchCodexUsage(
      account(),
      fakeFetch(200, {
        rate_limit: {
          primary_window: {
            used_percent: "lots",
            limit_window_seconds: WEEK,
            reset_at: 1,
          },
        },
      }).impl,
    ),
  );
});

// ── manager: cached, rate limited, never in the request path ───────────────

test("usage fields are null and nothing is fetched until tracking is enabled", async () => {
  const { manager, dir } = newManager();
  try {
    const snap = manager.getSnapshots()[0];
    assert.equal(snap.weeklyUsedPercent, null);
    assert.equal(snap.weeklyResetsAt, null);
    assert.equal(snap.fiveHourUsedPercent, null);
    assert.equal(snap.fiveHourResetsAt, null);
    const status = manager.getStatuses()[0];
    assert.equal(status.weeklyUsedPercent, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a read returns null at once, fetches in the background, then serves the cache", async () => {
  const { manager, dir } = newManager();
  try {
    let now = Date.now();
    const calls: string[] = [];
    let release!: (u: CodexUsage) => void;
    manager.enableUsageTracking({
      minIntervalMs: 5 * MIN,
      now: () => now,
      fetch: (acct) => {
        calls.push(acct.token.email);
        return new Promise<CodexUsage>((r) => (release = r));
      },
    });

    // Fetch is still pending, yet reads return synchronously with unknowns.
    assert.equal(manager.getSnapshots()[0].weeklyUsedPercent, null);
    manager.getSnapshots();
    manager.getStatuses();
    assert.equal(calls.length, 1, "one in-flight fetch, however many reads");

    const resetsAt = new Date(now + 3 * 86_400_000).toISOString();
    release(usage(72, resetsAt));
    await flush();
    const snap = manager.getSnapshots()[0];
    assert.equal(snap.weeklyUsedPercent, 72);
    assert.equal(snap.weeklyResetsAt, resetsAt);
    assert.equal(snap.fiveHourUsedPercent, 3);
    assert.equal(manager.getStatuses()[0].weeklyUsedPercent, 72);
    assert.equal(calls.length, 1);

    // Inside the interval: cache only.
    now += 4 * MIN;
    manager.getSnapshots();
    assert.equal(calls.length, 1);

    // Past it: serves the cached value while one refresh runs.
    now += 2 * MIN;
    assert.equal(manager.getSnapshots()[0].weeklyUsedPercent, 72);
    assert.equal(calls.length, 2);
    release(usage(75, resetsAt));
    await flush();
    assert.equal(manager.getSnapshots()[0].weeklyUsedPercent, 75);
    assert.equal(calls.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing or throwing fetch leaves unknowns, never throws, and backs off", async () => {
  const { manager, dir } = newManager();
  try {
    let now = Date.now();
    let calls = 0;
    manager.enableUsageTracking({
      minIntervalMs: 5 * MIN,
      now: () => now,
      fetch: () => {
        calls++;
        if (calls === 1) throw new Error("sync boom");
        return Promise.reject(new Error("endpoint moved"));
      },
    });
    assert.doesNotThrow(() => manager.getSnapshots());
    await flush();
    assert.equal(manager.getSnapshots()[0].weeklyUsedPercent, null);
    assert.equal(calls, 1, "no retry loop");

    // One interval later it tries again; a second failure doubles the wait.
    now += 6 * MIN;
    manager.getSnapshots();
    await flush();
    assert.equal(calls, 2);
    now += 6 * MIN;
    manager.getSnapshots();
    assert.equal(calls, 2, "backed off after a second failure");
    now += 20 * MIN;
    manager.getSnapshots();
    assert.equal(calls, 3);
    // The account itself is untouched by usage failures.
    const snap = manager.getSnapshots()[0];
    assert.equal(snap.available, true);
    assert.equal(snap.failureCount, 0);
    assert.equal(snap.lastError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a cached reading goes back to unknown once it is stale or its window has reset", async () => {
  const { manager, dir } = newManager();
  try {
    let now = Date.now();
    let fail = false;
    const resetsAt = new Date(now + 3 * 86_400_000).toISOString();
    manager.enableUsageTracking({
      minIntervalMs: 5 * MIN,
      now: () => now,
      fetch: async () => {
        if (fail) throw new Error("down");
        return usage(80, resetsAt);
      },
    });
    manager.getSnapshots();
    await flush();
    assert.equal(manager.getSnapshots()[0].weeklyUsedPercent, 80);

    fail = true;
    now += 20 * MIN;
    manager.getSnapshots();
    await flush();
    assert.equal(
      manager.getSnapshots()[0].weeklyUsedPercent,
      80,
      "still fresh enough",
    );
    now += 20 * MIN;
    assert.equal(manager.getSnapshots()[0].weeklyUsedPercent, null, "stale");

    // Past the reset time the old percent describes a window that ended.
    fail = false;
    now += 5 * MIN;
    manager.getSnapshots();
    await flush();
    now = Date.parse(resetsAt) + MIN;
    const snap = manager.getSnapshots()[0];
    assert.equal(snap.weeklyUsedPercent, null);
    assert.equal(snap.weeklyResetsAt, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("accounts that need re-auth are not polled", async () => {
  const { manager, dir } = newManager();
  try {
    let calls = 0;
    manager.enableUsageTracking({
      minIntervalMs: 5 * MIN,
      fetch: async () => {
        calls++;
        return usage(1, new Date(Date.now() + 86_400_000).toISOString());
      },
    });
    manager.recordFailure("owner@example.com", "auth", "401");
    manager.getSnapshots();
    await flush();
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── HTTP surface ───────────────────────────────────────────────────────────

const ADMIN = "sk-admin-0123456789abcdef";
const MARIA = "sk-maria-0123456789abcdef";

test("/admin/accounts and /v1/status carry the weekly and 5h readings", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-http-"));
  t.after(() => fs.rmSync(authDir, { recursive: true, force: true }));
  const registry = buildRegistry(authDir);
  const manager = registry.get("codex").manager;
  manager.addAccount(token());
  const resetsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
  manager.enableUsageTracking({
    minIntervalMs: 5 * MIN,
    fetch: async () => usage(64, resetsAt),
  });
  const keys: ApiKeyEntry[] = [
    { name: "boss", key: ADMIN, models: ["*"], admin: true },
    { name: "maria", key: MARIA, models: ["*"] },
  ];
  const configPath = path.join(authDir, "config.yaml");
  fs.writeFileSync(configPath, yaml.dump({ port: 1, "api-keys": keys }));
  const config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": keys,
    models: [],
    "body-limit": "1mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    debug: "off",
    stats: { enabled: false },
  } as unknown as Config;
  const app = createServer(config, registry, undefined, {
    persistKeys: persistApiKeys(configPath),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => server.close());
  const port = (server.address() as any).port;
  const get = async (p: string, key: string) =>
    (await fetch(`http://127.0.0.1:${port}${p}`, {
      headers: { authorization: `Bearer ${key}` },
    }).then((r) => r.json())) as any;

  const first = await get("/admin/accounts", ADMIN);
  assert.equal(first.providers.codex.accounts[0].weeklyUsedPercent, null);
  await flush();
  const admin = await get("/admin/accounts", ADMIN);
  const acct = admin.providers.codex.accounts[0];
  assert.equal(acct.weeklyUsedPercent, 64);
  assert.equal(acct.weeklyResetsAt, resetsAt);
  assert.equal(acct.fiveHourUsedPercent, 3);

  const status = await get("/v1/status", MARIA);
  const s = status.providers.codex.accounts[0];
  assert.equal(s.weeklyUsedPercent, 64);
  assert.equal(s.weeklyResetsAt, resetsAt);
  assert.ok(!JSON.stringify(status).includes("owner@example.com"));
});
