import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Config, loadConfig, validateDashboardUsers } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { hashPassword, verifyPassword } from "../src/auth/password";
import {
  LOGIN_FAILURE_LIMIT,
  LOGIN_WINDOW_MS,
  LoginThrottle,
  SESSION_TTL_MS,
  SessionStore,
} from "../src/auth/dashboard-login";

const ADMIN = "sk-admin-0123456789abcdef";
const MEMBER = "sk-member-0123456789abcdef";
const PASSWORD = "p@ss w0rd/with*odd!chars";

test("a password verifies only against its own hash, and each hash is salted", async () => {
  const a = await hashPassword(PASSWORD);
  const b = await hashPassword(PASSWORD);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword(PASSWORD, a), true);
  assert.equal(await verifyPassword(PASSWORD, b), true);
  assert.equal(await verifyPassword(PASSWORD + "x", a), false);
  assert.equal(await verifyPassword("", a), false);
  assert.equal(a.includes(PASSWORD), false);
});

test("a malformed stored hash never verifies and never throws", async () => {
  for (const bad of [
    "",
    "plaintext",
    "scrypt$1$2$3$x$y",
    "scrypt$0$0$0$AA==$AA==",
  ]) {
    assert.equal(await verifyPassword(PASSWORD, bad), false, bad);
  }
});

test("sessions expire after their lifetime and can be destroyed", () => {
  let now = 1000;
  const store = new SessionStore(() => now);
  const token = store.create("victor");
  assert.equal(store.get(token), "victor");
  now += SESSION_TTL_MS - 1;
  assert.equal(store.get(token), "victor");
  now += 1;
  assert.equal(store.get(token), undefined);
  const again = store.create("victor");
  store.destroy(again);
  assert.equal(store.get(again), undefined);
  assert.equal(store.get("0".repeat(64)), undefined);
});

test("the throttle blocks one IP after repeated failures, resets with time, and clears on success", () => {
  let now = 0;
  const t = new LoginThrottle(() => now);
  for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
    assert.equal(t.blocked("1.1.1.1"), false);
    t.fail("1.1.1.1");
  }
  assert.equal(t.blocked("1.1.1.1"), true);
  assert.equal(t.blocked("2.2.2.2"), false);
  now += LOGIN_WINDOW_MS;
  assert.equal(t.blocked("1.1.1.1"), false);
  t.fail("3.3.3.3");
  t.succeed("3.3.3.3");
  for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) t.fail("3.3.3.3");
  assert.equal(t.blocked("3.3.3.3"), false);
});

test("dashboard-users config rejects plain passwords, duplicates and blanks", async () => {
  const hash = await hashPassword(PASSWORD);
  assert.deepEqual(validateDashboardUsers(undefined), []);
  assert.equal(
    validateDashboardUsers([{ username: " Victor ", "password-hash": hash }])[0]
      .username,
    "Victor",
  );
  assert.throws(
    () =>
      validateDashboardUsers([{ username: "v", "password-hash": PASSWORD }]),
    /scrypt hash/,
  );
  assert.throws(
    () => validateDashboardUsers([{ username: " ", "password-hash": hash }]),
    /username/,
  );
  assert.throws(
    () =>
      validateDashboardUsers([
        { username: "v", "password-hash": hash },
        { username: "V", "password-hash": hash },
      ]),
    /duplicate/,
  );
  const file = path.join(os.tmpdir(), `auth2api-du-${Date.now()}.yaml`);
  fs.writeFileSync(
    file,
    `api-keys:\n  - {name: a, key: "${ADMIN}", models: ["*"], admin: true}\ndashboard-users:\n  - {username: victor, password-hash: "${hash}"}\n`,
  );
  try {
    assert.equal(loadConfig(file)["dashboard-users"]![0].username, "victor");
  } finally {
    fs.rmSync(file);
  }
});

async function startApp(t: test.TestContext) {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-login-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": [
      { name: "boss", key: ADMIN, models: ["*"], admin: true },
      { name: "maria", key: MEMBER, models: ["gpt-6-luna"] },
    ],
    "dashboard-users": [
      {
        username: "victor@dozaldevs.com",
        "password-hash": await hashPassword(PASSWORD),
      },
    ],
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
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (
    method: string,
    p: string,
    opts: { headers?: Record<string, string>; body?: unknown } = {},
  ) => {
    const res = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json", ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: text ? JSON.parse(text) : null,
    };
  };
  const login = async (
    password = PASSWORD,
    username = "victor@dozaldevs.com",
    headers = {},
  ) =>
    call("POST", "/admin/ui/login", { body: { username, password }, headers });
  const cookieOf = (res: { headers: Headers }) =>
    (res.headers.get("set-cookie") || "").split(";")[0];
  return { call, login, cookieOf };
}

test("a correct login sets a locked-down session cookie; usernames match case-insensitively", async (t) => {
  const { login } = await startApp(t);
  const ok = await login(PASSWORD, "Victor@DozalDevs.com");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.username, "victor@dozaldevs.com");
  const cookie = ok.headers.get("set-cookie") || "";
  assert.match(cookie, /^relay_session=[a-f0-9]{64};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\/admin/);
  assert.equal(/Secure/.test(cookie), false, "plain http gets no Secure flag");

  const behindTls = await login(PASSWORD, "victor@dozaldevs.com", {
    "x-forwarded-proto": "https",
  });
  assert.match(behindTls.headers.get("set-cookie") || "", /; Secure/);
});

test("wrong password and unknown user get the same answer", async (t) => {
  const { login } = await startApp(t);
  const wrong = await login("nope");
  const unknown = await login(PASSWORD, "someone@else.com");
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.equal(wrong.headers.get("set-cookie"), null);
  assert.equal((await login("")).status, 401);
});

test("a session cookie acts as an admin, but only with the CSRF header", async (t) => {
  const { call, login, cookieOf } = await startApp(t);
  const cookie = cookieOf(await login());

  assert.equal(
    (await call("GET", "/admin/keys", { headers: { cookie } })).status,
    403,
  );
  const listed = await call("GET", "/admin/keys", {
    headers: { cookie, "x-relay-csrf": "1" },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.keys.length, 2);

  const made = await call("POST", "/admin/keys", {
    headers: { cookie, "x-relay-csrf": "1" },
    body: { name: "newhire", models: ["gpt-6-luna"] },
  });
  assert.equal(made.status, 201);

  assert.equal((await call("GET", "/admin/keys")).status, 401);
  const session = await call("GET", "/admin/ui/session", {
    headers: { cookie },
  });
  assert.equal(session.body.username, "victor@dozaldevs.com");
  assert.equal((await call("GET", "/admin/ui/session")).status, 401);
});

test("a cookie does not open the model endpoints", async (t) => {
  const { call, login, cookieOf } = await startApp(t);
  const cookie = cookieOf(await login());
  const res = await call("POST", "/v1/chat/completions", {
    headers: { cookie, "x-relay-csrf": "1" },
    body: { model: "gpt-6-luna", messages: [] },
  });
  assert.equal(res.status, 401);
});

test("logging out ends the session even if the browser keeps sending the cookie", async (t) => {
  const { call, login, cookieOf } = await startApp(t);
  const cookie = cookieOf(await login());
  const h = { cookie, "x-relay-csrf": "1" };
  assert.equal((await call("GET", "/admin/keys", { headers: h })).status, 200);
  const out = await call("POST", "/admin/ui/logout", { headers: { cookie } });
  assert.equal(out.status, 204);
  assert.match(out.headers.get("set-cookie") || "", /Max-Age=0/);
  assert.equal((await call("GET", "/admin/keys", { headers: h })).status, 401);
});

test("API keys still work on /admin exactly as before", async (t) => {
  const { call, login, cookieOf } = await startApp(t);
  assert.equal(
    (
      await call("GET", "/admin/keys", {
        headers: { authorization: `Bearer ${ADMIN}` },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("GET", "/admin/keys", {
        headers: { authorization: `Bearer ${MEMBER}` },
      })
    ).status,
    403,
  );
  const cookie = cookieOf(await login());
  const bearerWins = await call("GET", "/admin/keys", {
    headers: { authorization: `Bearer ${MEMBER}`, cookie, "x-relay-csrf": "1" },
  });
  assert.equal(bearerWins.status, 403);
});

test("repeated wrong passwords lock the IP out, even for the right password", async (t) => {
  const { login } = await startApp(t);
  for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++)
    assert.equal((await login("bad")).status, 401);
  const locked = await login(PASSWORD);
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get("set-cookie"), null);
});
