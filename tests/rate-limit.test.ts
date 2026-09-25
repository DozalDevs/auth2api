import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AddressInfo } from "node:net";

import { Config } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import {
  API_KEY_RATE_LIMIT_MAX,
  IP_RATE_LIMIT_MAX,
  RateLimiter,
  clientIp,
} from "../src/utils/rate-limit";

function makeConfig(authDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": new Set(["test-key"]),
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
}

async function startApp(t: test.TestContext): Promise<number> {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-rl-"));
  const app = createServer(makeConfig(authDir), buildRegistry(authDir));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.close();
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  return (server.address() as AddressInfo).port;
}

function get(
  port: number,
  p: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: p, headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: JSON.parse(data) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function fakeReq(headers: Record<string, string>, ip = "172.16.44.26"): any {
  return { headers, ip, socket: { remoteAddress: ip } };
}

test("authenticated callers behind one proxy IP get the api-key budget, not 60/min", async (t) => {
  const port = await startApp(t);
  const auth = { authorization: "Bearer test-key" };
  let limited = 0;
  for (let i = 0; i < 70; i++) {
    const res = await get(port, "/v1/models", auth);
    if (res.status === 429) limited++;
  }
  assert.equal(limited, 0);

  const stats = await get(port, "/admin/stats", auth);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.rateLimited.rejected, 0);
  assert.equal(stats.body.rateLimited.limits.api_key, API_KEY_RATE_LIMIT_MAX);
});

test("unauthenticated requests keep the per-IP limit and are counted in /admin/stats", async (t) => {
  const port = await startApp(t);
  const statuses: number[] = [];
  for (let i = 0; i < IP_RATE_LIMIT_MAX + 2; i++) {
    statuses.push((await get(port, "/v1/models")).status);
  }
  assert.equal(statuses.filter((s) => s === 401).length, IP_RATE_LIMIT_MAX);
  assert.equal(statuses.filter((s) => s === 429).length, 2);

  const stats = await get(port, "/admin/stats", {
    authorization: "Bearer test-key",
  });
  assert.equal(stats.body.rateLimited.rejected, 2);
  assert.deepEqual(stats.body.rateLimited.rejected_by_scope, {
    api_key: 0,
    ip: 2,
  });
  assert.ok(stats.body.rateLimited.last_rejected_at);
});

test("an unknown key is limited per IP, so guessing keys can't mint fresh buckets", () => {
  const limiter = new RateLimiter(new Set(["good"]), { api_key: 5, ip: 2 });
  const results = ["a", "b", "c"].map((k) =>
    limiter.allow(fakeReq({ authorization: `Bearer ${k}` })),
  );
  assert.deepEqual(results, [true, true, false]);
  assert.equal(limiter.snapshot().rejected_by_scope.ip, 1);
});

test("the api-key bucket still caps and resets after the window", () => {
  let now = 0;
  const limiter = new RateLimiter(
    new Set(["good"]),
    { api_key: 3, ip: 1 },
    1000,
    () => now,
  );
  const req = fakeReq({ authorization: "Bearer good" });
  assert.deepEqual(
    [1, 2, 3, 4].map(() => limiter.allow(req)),
    [true, true, true, false],
  );
  assert.equal(limiter.snapshot().rejected_by_scope.api_key, 1);
  now = 1001;
  assert.equal(limiter.allow(req), true);
});

test("clientIp uses Fly-Client-IP only when running on Fly", (t) => {
  const prev = process.env.FLY_APP_NAME;
  t.after(() => {
    if (prev === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prev;
  });
  const req = fakeReq({ "fly-client-ip": "203.0.113.9" });

  delete process.env.FLY_APP_NAME;
  assert.equal(clientIp(req), "172.16.44.26");

  process.env.FLY_APP_NAME = "dozaldevs-codex-relay";
  assert.equal(clientIp(req), "203.0.113.9");

  // Distinct real clients behind one proxy address get distinct IP buckets.
  const limiter = new RateLimiter(new Set(), { api_key: 1, ip: 1 });
  assert.equal(
    limiter.allow(fakeReq({ "fly-client-ip": "203.0.113.1" })),
    true,
  );
  assert.equal(
    limiter.allow(fakeReq({ "fly-client-ip": "203.0.113.2" })),
    true,
  );
  assert.equal(
    limiter.allow(fakeReq({ "fly-client-ip": "203.0.113.1" })),
    false,
  );
});
