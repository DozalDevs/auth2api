import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Config } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";

const ADMIN = "sk-admin-0123456789abcdef";

async function startApp(t: test.TestContext) {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-ui-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": [{ name: "boss", key: ADMIN, models: ["*"], admin: true }],
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
  const server = createServer(config, buildRegistry(authDir)).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => {
    server.close();
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

test("the dashboard page is served without a key, but the API behind it is not", async (t) => {
  const base = await startApp(t);
  const page = await fetch(`${base}/admin/ui`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const html = await page.text();
  assert.equal(html.includes(ADMIN), false);

  assert.equal((await fetch(`${base}/admin/keys`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/admin/keys`, {
        headers: { authorization: "Bearer sk-nope-0123456789abcdef" },
      })
    ).status,
    403,
  );
});

test("the CSP allows exactly the page's own script and stylesheet and nothing inline beyond them", async (t) => {
  const base = await startApp(t);
  const page = await fetch(`${base}/admin/ui`);
  const csp = page.headers.get("content-security-policy") || "";
  const html = await page.text();

  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const style = html.match(/<style>([\s\S]*?)<\/style>/)![1];
  const hash = (s: string) =>
    `'sha256-${crypto.createHash("sha256").update(s).digest("base64")}'`;
  assert.ok(csp.includes(`script-src ${hash(script)}`));
  assert.ok(csp.includes(`style-src ${hash(style)}`));
  assert.ok(csp.includes("default-src 'none'"));
  assert.equal(csp.includes("unsafe-inline"), false);

  // The CSP would silently break either of these, so keep them out of the markup.
  assert.equal(/\sstyle\s*=/.test(html), false, "inline style attribute");
  assert.equal(/\son[a-z]+\s*=/.test(html), false, "inline event handler");
  assert.equal(/<script[^>]*\ssrc=/.test(html), false, "external script");
});

test("the account page is public, locked down the same way, and its API is not open", async (t) => {
  const base = await startApp(t);
  const page = await fetch(`${base}/account`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const csp = page.headers.get("content-security-policy") || "";
  const html = await page.text();
  assert.equal(html.includes(ADMIN), false);

  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const style = html.match(/<style>([\s\S]*?)<\/style>/)![1];
  const hash = (s: string) =>
    `'sha256-${crypto.createHash("sha256").update(s).digest("base64")}'`;
  assert.ok(csp.includes(`script-src ${hash(script)}`));
  assert.ok(csp.includes(`style-src ${hash(style)}`));
  assert.equal(csp.includes("unsafe-inline"), false);
  assert.equal(/\sstyle\s*=/.test(html), false, "inline style attribute");
  assert.equal(/\son[a-z]+\s*=/.test(html), false, "inline event handler");

  assert.equal((await fetch(`${base}/account/api/me`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/account/api/me`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      })
    ).status,
    401,
  );
});
