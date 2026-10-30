import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import yaml from "js-yaml";

import {
  ApiKeyEntry,
  Config,
  loadConfig,
  persistAccessRequests,
  persistApiKeys,
  persistCatalog,
  persistInvites,
  persistMembers,
} from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { StatsRecorder } from "../src/stats/recorder";
import { hashApiKey } from "../src/utils/common";
import { hashPassword } from "../src/auth/password";

const ADMIN = "sk-admin-0123456789abcdef";
const MARIA = "sk-maria-0123456789abcdef";
const OMAR = "sk-omar-0123456789abcdef";
const START = Date.parse("2026-10-30T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const PASSWORD = "correct horse battery";
const PUBLIC = "https://relay.example.com";

function entries(): ApiKeyEntry[] {
  return [
    { name: "boss", key: ADMIN, models: ["*"], admin: true },
    {
      name: "maria",
      key: MARIA,
      models: ["@standard"],
      "daily-token-limit": 500_000,
    },
    { name: "omar", key: OMAR, models: ["gpt-6-luna"] },
  ];
}

async function startSlack(
  reply: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: { ok: true },
  }),
) {
  const posts: Array<{ auth: string | undefined; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      posts.push({
        auth: req.headers.authorization,
        body: JSON.parse(raw || "{}"),
        url: req.url,
      } as any);
      const r = reply();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { posts, base, close: () => server.close() };
}

async function startApp(
  t: test.TestContext,
  opts: { slackBase?: string; publicUrl?: string | null } = {},
) {
  const clock = { t: START };
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-"));
  const configPath = path.join(authDir, "config.yaml");
  const models = [
    { id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" as const },
    {
      id: "go/glm-5.3-flash",
      name: "GLM-5.3 Flash (OpenCode Go)",
      access: "standard" as const,
    },
    {
      id: "go/kimi-k3",
      name: "Kimi K3 (OpenCode Go)",
      access: "on_request" as const,
    },
    { id: "gpt-6-sol", name: "GPT-6 Sol", access: "on_request" as const },
  ];
  fs.writeFileSync(configPath, yaml.dump({ "api-keys": entries(), models }));
  const stats = new StatsRecorder();
  stats.applyEvent({
    v: 1,
    ts: new Date(START - 1000).toISOString(),
    apiKeyHash: hashApiKey(MARIA),
    ip: "1",
    ua: "x",
    endpoint: "POST /v1/chat/completions",
    model: "gpt-6-luna",
    provider: "codex",
    accountEmail: "a@b.c",
    status: "success",
    failureKind: null,
    statusCode: 200,
    latencyMs: 1,
    usage: {
      inputTokens: 300,
      outputTokens: 40,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    } as any,
  });
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": entries(),
    models,
    "dashboard-users": [
      {
        username: "leo@example.com",
        "password-hash": await hashPassword(PASSWORD),
      },
    ],
    ...(opts.slackBase
      ? {
          notifications: {
            slack: {
              "bot-token": "xoxb-test-token",
              channel: "C0TESTCHAN1",
              "api-base": opts.slackBase,
            },
          },
        }
      : {}),
    ...(opts.publicUrl === null
      ? {}
      : { "public-url": opts.publicUrl ?? PUBLIC }),
    "body-limit": "1mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    stats: { enabled: true },
    debug: "off",
  } as any;
  const app = createServer(config, buildRegistry(authDir), stats, {
    persistKeys: persistApiKeys(configPath),
    persistCatalog: persistCatalog(configPath),
    persistRequests: persistAccessRequests(configPath),
    persistMembers: persistMembers(configPath),
    persistInvites: persistInvites(configPath),
    now: () => clock.t,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(() => {
    server.close();
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (
    method: string,
    p: string,
    o: {
      key?: string;
      cookie?: string;
      body?: unknown;
      csrf?: boolean;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        "content-type": "application/json",
        ...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...(o.csrf === false
          ? {}
          : p.startsWith("/account") || o.cookie
            ? { "x-relay-csrf": "1" }
            : {}),
        ...(o.headers ?? {}),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return {
      status: res.status,
      body: json,
      text,
      setCookie: res.headers.get("set-cookie") ?? "",
    };
  };
  const cookieOf = (r: { setCookie: string }) => r.setCookie.split(";")[0];
  const invite = async (name: string, email: string) =>
    await call("POST", `/admin/keys/${name}/invite`, {
      key: ADMIN,
      body: { email },
    });
  const tokenOf = (link: string) => link.split("#invite=")[1];
  const join = async (name: string, email: string, password = PASSWORD) => {
    const inv = await invite(name, email);
    const r = await call("POST", "/account/api/accept", {
      body: { token: tokenOf(inv.body.link), password },
    });
    assert.equal(r.status, 201, r.text);
    return cookieOf(r);
  };
  return { call, clock, configPath, invite, tokenOf, join, cookieOf, base };
}

test("an admin invites someone, the link works once, and the config never holds the link or the password", async (t) => {
  const { call, invite, tokenOf, cookieOf, configPath } = await startApp(t);
  const inv = await invite("maria", "Maria@Example.com");
  assert.equal(inv.status, 201);
  assert.match(
    inv.body.link,
    new RegExp(`^${PUBLIC}/account#invite=[A-Za-z0-9_-]{40,}$`),
  );
  assert.equal(inv.body.email, "maria@example.com");
  const token = tokenOf(inv.body.link);

  let keys = (await call("GET", "/admin/keys", { key: ADMIN })).body.keys;
  const row = keys.find((k: any) => k.name === "maria");
  assert.equal(row.login, null);
  assert.equal(row.invite.email, "maria@example.com");
  assert.equal(JSON.stringify(row).includes(token), false);

  const short = await call("POST", "/account/api/accept", {
    body: { token, password: "short" },
  });
  assert.equal(short.status, 400);
  assert.match(short.body.error.message, /at least 12 characters/);

  const ok = await call("POST", "/account/api/accept", {
    body: { token, password: PASSWORD },
  });
  assert.equal(ok.status, 201);
  assert.match(
    ok.setCookie,
    /^relay_member=[a-f0-9]{64}; Max-Age=43200; HttpOnly; SameSite=Strict; Path=\/account/,
  );
  assert.equal(
    (await call("GET", "/account/api/session", { cookie: cookieOf(ok) })).body
      .email,
    "maria@example.com",
  );

  const again = await call("POST", "/account/api/accept", {
    body: { token, password: PASSWORD },
  });
  assert.equal(again.status, 400, "a used link does not work a second time");
  assert.match(again.body.error.message, /already used/);

  keys = (await call("GET", "/admin/keys", { key: ADMIN })).body.keys;
  const after = keys.find((k: any) => k.name === "maria");
  assert.equal(after.login, "maria@example.com");
  assert.equal(after.invite, null);

  const saved = fs.readFileSync(configPath, "utf8");
  assert.equal(saved.includes(token), false, "the link itself is never stored");
  assert.equal(saved.includes(PASSWORD), false, "the password is never stored");
  const cfg = loadConfig(configPath);
  assert.equal(cfg.members!.length, 1);
  assert.match(cfg.members![0]["password-hash"], /^scrypt\$/);
  assert.deepEqual(cfg.invites, []);
});

test("an invite can be replaced, expires after a week, and cannot take an email that belongs to another key", async (t) => {
  const { call, clock, invite, tokenOf, join } = await startApp(t);
  const first = await invite("maria", "maria@example.com");
  const second = await invite("maria", "maria@example.com");
  const old = await call("POST", "/account/api/accept", {
    body: { token: tokenOf(first.body.link), password: PASSWORD },
  });
  assert.equal(old.status, 400, "a newer link replaces the older one");

  clock.t = START + 8 * DAY;
  const late = await call("POST", "/account/api/accept", {
    body: { token: tokenOf(second.body.link), password: PASSWORD },
  });
  assert.equal(late.status, 410);
  assert.match(late.body.error.message, /expired/);

  clock.t = START;
  await join("maria", "maria@example.com");
  const clash = await invite("omar", "MARIA@example.com");
  assert.equal(clash.status, 409);
  assert.equal((await invite("omar", "not-an-email")).status, 400);
  assert.equal((await invite("ghost", "g@example.com")).status, 404);
});

test("sign-in: wrong and unknown answer the same, ten failures lock the address out, and a good password works", async (t) => {
  const { call, join, cookieOf } = await startApp(t);
  await join("maria", "maria@example.com");
  const wrong = await call("POST", "/account/api/login", {
    body: { email: "maria@example.com", password: "nope-nope-nope" },
  });
  const unknown = await call("POST", "/account/api/login", {
    body: { email: "nobody@example.com", password: "nope-nope-nope" },
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(
    wrong.body,
    unknown.body,
    "nothing reveals which emails have an account",
  );
  const good = await call("POST", "/account/api/login", {
    body: { email: "MARIA@example.com", password: PASSWORD },
  });
  assert.equal(good.status, 200);
  assert.equal(
    (await call("GET", "/account/api/me", { cookie: cookieOf(good) })).status,
    200,
  );

  for (let i = 0; i < 10; i++)
    await call("POST", "/account/api/login", {
      body: { email: "maria@example.com", password: "nope-nope-nope" },
    });
  const locked = await call("POST", "/account/api/login", {
    body: { email: "maria@example.com", password: PASSWORD },
  });
  assert.equal(
    locked.status,
    429,
    "even the right password is refused once the address is locked out",
  );
});

test("a teammate can never reach the admin side, and an admin session or key is not a teammate", async (t) => {
  const { call, join } = await startApp(t);
  const cookie = await join("maria", "maria@example.com");

  for (const p of [
    "/admin/keys",
    "/admin/access-requests",
    "/admin/models",
    "/admin/usage",
    "/admin/go",
  ]) {
    const r = await call("GET", p, { cookie });
    assert.ok([401, 403].includes(r.status), `${p} -> ${r.status}`);
  }
  const post = await call("POST", "/admin/keys/maria/invite", {
    cookie,
    body: { email: "x@example.com" },
  });
  assert.ok([401, 403].includes(post.status));
  const approve = await call(
    "POST",
    "/admin/access-requests/deadbeef/approve",
    { cookie, body: {} },
  );
  assert.ok([401, 403].includes(approve.status));
  assert.equal(
    (await call("GET", "/v1/models", { cookie })).status,
    401,
    "the account cookie is not an API key",
  );

  assert.equal(
    (await call("GET", "/account/api/me", { key: ADMIN })).status,
    401,
    "an admin key is not a teammate sign-in",
  );
  assert.equal(
    (
      await call("GET", "/account/api/me", {
        cookie: "relay_session=" + "a".repeat(64),
      })
    ).status,
    401,
  );
  assert.equal((await call("GET", "/account/api/me")).status, 401);
});

test("an admin dashboard session does not open the account API", async (t) => {
  const { call } = await startApp(t);
  const login = await call("POST", "/admin/ui/login", {
    body: { username: "leo@example.com", password: PASSWORD },
  });
  assert.equal(login.status, 200);
  const admin = login.setCookie.split(";")[0];
  assert.equal(
    (await call("GET", "/admin/keys", { cookie: admin })).status,
    200,
    "the admin session itself works",
  );
  assert.equal(
    (await call("GET", "/account/api/me", { cookie: admin })).status,
    401,
  );
  assert.match(login.setCookie, /Path=\/admin/);
});

test("the page API needs the custom header on anything that changes state", async (t) => {
  const { call, join } = await startApp(t);
  const cookie = await join("maria", "maria@example.com");
  const r = await call("POST", "/account/api/requests", {
    cookie,
    csrf: false,
    body: { model: "go/kimi-k3", reason: "x" },
  });
  assert.equal(r.status, 403);
  assert.match(r.body.error.message, /x-relay-csrf/);
});

test("what the teammate sees: their models, loans, pending asks, limit, usage, and never their key", async (t) => {
  const { call, join } = await startApp(t);
  const cookie = await join("maria", "maria@example.com");
  await call("POST", "/admin/keys/maria/grants", {
    key: ADMIN,
    body: { models: ["gpt-6-sol"], hours: 2, note: "x" },
  });
  const ask = await call("POST", "/account/api/requests", {
    cookie,
    body: { model: "go/kimi-k3", reason: "compare it with GLM", hours: 4 },
  });
  assert.equal(ask.status, 201);

  const me = await call("GET", "/account/api/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(
    me.text.includes(MARIA),
    false,
    "the key itself is never in the response",
  );
  assert.deepEqual(me.body.key, {
    name: "maria",
    suffix: "cdef",
    disabled: false,
  });
  const by = (id: string) => me.body.models.find((m: any) => m.id === id);
  assert.equal(by("gpt-6-luna").state, "allowed");
  assert.equal(by("go/glm-5.3-flash").state, "allowed");
  assert.equal(by("gpt-6-sol").state, "allowed");
  assert.equal(by("gpt-6-sol").loan.seconds_left, 7200);
  assert.equal(by("gpt-6-luna").loan, null);
  assert.equal(by("go/kimi-k3").state, "ask");
  assert.equal(by("go/kimi-k3").pending_request, ask.body.id);
  assert.equal(me.body.daily_token_limit, 500_000);
  assert.equal(me.body.tokens_today, 340);
  assert.equal(me.body.usage.days[0].tokens, 340);
  assert.equal(me.body.requests[0].reason, "compare it with GLM");
});

test("a teammate can only ever act on their own key, whatever the browser sends", async (t) => {
  const { call, join } = await startApp(t);
  const maria = await join("maria", "maria@example.com");
  const omar = await join("omar", "omar@example.com");

  const forged = await call("POST", "/account/api/requests", {
    cookie: maria,
    body: { model: "go/kimi-k3", reason: "hello", key: "omar", name: "omar" },
  });
  assert.equal(forged.status, 201);
  assert.equal(forged.body.key, "maria", "the key comes from the session");
  const omarView = await call("GET", "/account/api/me", { cookie: omar });
  assert.deepEqual(omarView.body.requests, [], "omar sees nothing of maria's");
  const steal = await call(
    "DELETE",
    `/account/api/requests/${forged.body.id}`,
    { cookie: omar },
  );
  assert.equal(steal.status, 404);
  const own = await call("DELETE", `/account/api/requests/${forged.body.id}`, {
    cookie: maria,
  });
  assert.equal(own.status, 200);
  assert.equal(own.body.status, "cancelled");
});

test("asking needs a reason, an admin decides, and the answer shows on the teammate's page", async (t) => {
  const { call, join } = await startApp(t);
  const cookie = await join("maria", "maria@example.com");
  for (const reason of [undefined, "", "   "]) {
    const r = await call("POST", "/account/api/requests", {
      cookie,
      body: { model: "go/kimi-k3", reason },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /reason is required/);
  }
  const ask = await call("POST", "/account/api/requests", {
    cookie,
    body: { model: "go/kimi-k3", reason: "review the redesign", hours: 2 },
  });
  assert.equal(ask.status, 201);
  const wait = await call("GET", "/admin/access-requests", { key: ADMIN });
  assert.equal(wait.body.requests[0].reason, "review the redesign");
  await call("POST", `/admin/access-requests/${ask.body.id}/approve`, {
    key: ADMIN,
    body: { minutes: 30, note: "ok" },
  });
  const me = await call("GET", "/account/api/me", { cookie });
  const kimi = me.body.models.find((m: any) => m.id === "go/kimi-k3");
  assert.equal(kimi.state, "allowed");
  assert.equal(kimi.loan.seconds_left, 1800);
  assert.equal(me.body.requests[0].status, "approved");
  assert.equal(me.body.requests[0].decision_note, "ok");
});

test("removing someone's sign-in, or their key, signs them out and removes the sign-in", async (t) => {
  const { call, join, configPath } = await startApp(t);
  const maria = await join("maria", "maria@example.com");
  const omar = await join("omar", "omar@example.com");
  assert.equal(
    (await call("DELETE", "/admin/keys/maria/login", { key: ADMIN })).status,
    204,
  );
  assert.equal(
    (await call("GET", "/account/api/me", { cookie: maria })).status,
    401,
    "their open session stops working",
  );
  assert.equal(
    (await call("DELETE", "/admin/keys/maria/login", { key: ADMIN })).status,
    404,
  );
  assert.equal(
    (
      await call("POST", "/account/api/login", {
        body: { email: "maria@example.com", password: PASSWORD },
      })
    ).status,
    401,
  );

  assert.equal(
    (await call("DELETE", "/admin/keys/omar", { key: ADMIN })).status,
    204,
  );
  assert.equal(
    (await call("GET", "/account/api/me", { cookie: omar })).status,
    401,
  );
  assert.deepEqual(loadConfig(configPath).members, []);
});

test("a Slack message goes to the channel when someone asks, with the reason escaped and a link only when the address is configured", async (t) => {
  const slack = await startSlack();
  t.after(() => slack.close());
  const { call, join } = await startApp(t, { slackBase: slack.base });
  const cookie = await join("maria", "maria@example.com");
  const ask = await call("POST", "/account/api/requests", {
    cookie,
    body: {
      model: "go/kimi-k3",
      reason: "<!channel> compare & contrast\nsecond line",
      hours: 4,
    },
  });
  assert.equal(ask.status, 201);
  await waitFor(() => slack.posts.length === 1);
  const post = slack.posts[0];
  assert.equal(post.auth, "Bearer xoxb-test-token");
  assert.equal(post.body.channel, "C0TESTCHAN1");
  const text: string = post.body.text;
  assert.match(
    text,
    /\*maria\* is asking for \*Kimi K3 \(OpenCode Go\)\* for 4 hours/,
  );
  assert.ok(
    text.includes("&lt;!channel&gt; compare &amp; contrast"),
    "the reason cannot ping the channel",
  );
  assert.ok(text.includes("> second line"));
  assert.ok(
    text.includes(`<${PUBLIC}/admin/ui?tab=requests|Approve or reject it>`),
  );

  const viaKey = await call("POST", "/access-requests", {
    key: MARIA,
    body: { model: "gpt-6-sol", reason: "from a script" },
  });
  assert.equal(viaKey.status, 201);
  await waitFor(() => slack.posts.length === 2);
  assert.match(slack.posts[1].body.text, /GPT-6 Sol/);
});

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a Slack problem never stops someone from asking", async (t) => {
  const down = await startSlack(() => ({
    status: 200,
    body: { ok: false, error: "not_in_channel" },
  }));
  t.after(() => down.close());
  const a = await startApp(t, { slackBase: down.base, publicUrl: null });
  const cookieA = await a.join("maria", "maria@example.com");
  const ok = await a.call("POST", "/account/api/requests", {
    cookie: cookieA,
    body: { model: "go/kimi-k3", reason: "still works" },
  });
  assert.equal(ok.status, 201, "Slack said no, the request still went through");
  await waitFor(() => down.posts.length === 1);
  assert.equal(
    down.posts[0].body.text.includes("Approve or reject it"),
    false,
    "no link without a configured address",
  );

  const b = await startApp(t, { slackBase: "http://127.0.0.1:1" });
  const cookieB = await b.join("omar", "omar@example.com");
  const refused = await b.call("POST", "/account/api/requests", {
    cookie: cookieB,
    body: { model: "go/kimi-k3", reason: "slack is unreachable" },
  });
  assert.equal(
    refused.status,
    201,
    "Slack unreachable, the request still went through",
  );
});

test("a model the key cannot use says where to ask, in plain words", async (t) => {
  const a = await startApp(t);
  const denied = await a.call("POST", "/v1/chat/completions", {
    key: OMAR,
    body: { model: "go/kimi-k3", messages: [] },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.type, "model_not_allowed");
  assert.equal(
    denied.body.error.message,
    `"go/kimi-k3" is not on your key. Ask for it at ${PUBLIC}/account?ask=go%2Fkimi-k3, or ask the engineering team.`,
  );

  const b = await startApp(t, { publicUrl: null });
  const fallback = await b.call("POST", "/v1/chat/completions", {
    key: OMAR,
    body: { model: "go/kimi-k3", messages: [] },
  });
  assert.match(
    fallback.body.error.message,
    /Ask for it at http:\/\/127\.0\.0\.1:\d+\/account\?ask=go%2Fkimi-k3/,
  );
});

test("config checks: a sign-in for a deleted key is dropped with a warning, and bad entries are refused", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.yaml");
  const hash = await hashPassword(PASSWORD);
  const base = { "api-keys": entries() };
  fs.writeFileSync(
    file,
    yaml.dump({
      ...base,
      members: [
        { email: "gone@example.com", key: "nobody", "password-hash": hash },
        { email: "maria@example.com", key: "maria", "password-hash": hash },
      ],
    }),
  );
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => warnings.push(m);
  try {
    assert.deepEqual(
      loadConfig(file).members!.map((m) => m.email),
      ["maria@example.com"],
    );
  } finally {
    console.warn = warn;
  }
  assert.match(warnings[0], /ignoring sign-in for gone@example\.com/);

  const bad = (extra: unknown, re: RegExp) => {
    fs.writeFileSync(file, yaml.dump({ ...base, ...(extra as object) }));
    assert.throws(() => loadConfig(file), re);
  };
  bad(
    { members: [{ email: "nope", key: "maria", "password-hash": hash }] },
    /email must be an email/,
  );
  bad(
    {
      members: [
        { email: "a@example.com", key: "maria", "password-hash": "plain" },
      ],
    },
    /scrypt hash/,
  );
  bad(
    {
      members: [
        { email: "a@example.com", key: "maria", "password-hash": hash },
        { email: "b@example.com", key: "maria", "password-hash": hash },
      ],
    },
    /more than one sign-in/,
  );
  bad(
    { notifications: { slack: { "bot-token": "x", channel: "general" } } },
    /channel id/,
  );
  bad({ "public-url": "relay.example.com" }, /public-url/);
});

test("a setup code lets the setup script fetch the person's own key once, and nothing else", async (t) => {
  const { call, join } = await startApp(t);
  const maria = await join("maria", "maria@example.com");
  const omar = await join("omar", "omar@example.com");

  assert.equal(
    (await call("POST", "/account/api/setup-code", {})).status,
    401,
    "needs a teammate sign-in",
  );
  assert.equal(
    (await call("POST", "/account/api/setup-code", { key: ADMIN })).status,
    401,
    "an admin key is not a sign-in",
  );
  assert.equal(
    (
      await call("POST", "/account/api/setup-code", {
        cookie: maria,
        csrf: false,
      })
    ).status,
    403,
  );

  const minted = await call("POST", "/account/api/setup-code", {
    cookie: maria,
  });
  assert.equal(minted.status, 201);
  assert.match(minted.body.code, /^[A-Za-z0-9_-]{30,}$/);
  assert.equal(
    minted.text.includes(MARIA),
    false,
    "the page never gets the key itself",
  );

  const got = await call("POST", "/setup/redeem", {
    body: { code: minted.body.code },
  });
  assert.equal(got.status, 200);
  assert.equal(got.body.key, MARIA);
  assert.equal(
    (await call("POST", "/setup/redeem", { body: { code: minted.body.code } }))
      .status,
    400,
    "a code works once",
  );

  const theirs = await call("POST", "/account/api/setup-code", {
    cookie: omar,
  });
  assert.equal(
    (await call("POST", "/setup/redeem", { body: { code: theirs.body.code } }))
      .body.key,
    OMAR,
  );
});

test("a setup code expires after fifteen minutes, and only a few can be live at once", async (t) => {
  const { call, join, clock } = await startApp(t);
  const maria = await join("maria", "maria@example.com");
  const old = await call("POST", "/account/api/setup-code", { cookie: maria });
  clock.t = START + 15 * 60_000 + 1;
  assert.equal(
    (await call("POST", "/setup/redeem", { body: { code: old.body.code } }))
      .status,
    400,
  );

  clock.t = START;
  const codes: string[] = [];
  for (let i = 0; i < 6; i++) {
    codes.push(
      (await call("POST", "/account/api/setup-code", { cookie: maria })).body
        .code,
    );
    clock.t += 1000;
  }
  assert.equal(
    (await call("POST", "/setup/redeem", { body: { code: codes[0] } })).status,
    400,
    "the oldest of six is gone",
  );
  assert.equal(
    (await call("POST", "/setup/redeem", { body: { code: codes[5] } })).status,
    200,
  );
});

test("guessing setup codes is limited, and a switched-off key gets none", async (t) => {
  const { call, join } = await startApp(t);
  const maria = await join("maria", "maria@example.com");
  const good = await call("POST", "/account/api/setup-code", { cookie: maria });
  for (let i = 0; i < 10; i++) {
    const r = await call("POST", "/setup/redeem", {
      body: { code: "x".repeat(30) + i },
    });
    assert.equal(r.status, 400);
  }
  const locked = await call("POST", "/setup/redeem", {
    body: { code: good.body.code },
  });
  assert.equal(
    locked.status,
    429,
    "even the right code is refused once the address is locked out",
  );

  const other = await startApp(t);
  const cookie = await other.join("maria", "maria@example.com");
  const code = await other.call("POST", "/account/api/setup-code", { cookie });
  await other.call("PATCH", "/admin/keys/maria", {
    key: ADMIN,
    body: { disabled: true },
  });
  assert.equal(
    (
      await other.call("POST", "/setup/redeem", {
        body: { code: code.body.code },
      })
    ).status,
    400,
    "a disabled key's code is refused",
  );
  assert.equal(
    (await other.call("POST", "/account/api/setup-code", { cookie })).status,
    403,
  );
  assert.equal(
    (await other.call("POST", "/setup/redeem", { body: {} })).status,
    400,
  );
});

test(
  "the real setup script, served by the relay, sets a teammate up from a code with no key typed anywhere",
  { skip: process.platform === "win32" },
  async (t) => {
    const { call, join, base } = await startApp(t);
    const maria = await join("maria", "maria@example.com");
    const minted = await call("POST", "/account/api/setup-code", {
      cookie: maria,
    });
    const served = await (await fetch(`${base}/setup/opencode.sh`)).text();

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "account-setup-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      RELAY_SETUP_CODE: minted.body.code,
    };
    delete env.RELAY_API_KEY;
    delete env.RELAY_URL;
    const out = await new Promise<{ code: number | null; text: string }>(
      (resolve) => {
        const child = spawn("/bin/bash", [], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (c) => (text += c));
        child.stderr.on("data", (c) => (text += c));
        child.on("close", (code) => resolve({ code, text }));
        child.stdin.end(served);
      },
    );
    assert.equal(out.code, 0, out.text);
    assert.match(out.text, /All set/);
    assert.equal(out.text.includes(MARIA), false, "the key is never printed");
    assert.equal(
      fs.readFileSync(
        path.join(home, "data", "opencode", "dozaldevs-relay.key"),
        "utf8",
      ),
      MARIA,
    );
    assert.equal(
      (
        await call("POST", "/setup/redeem", {
          body: { code: minted.body.code },
        })
      ).status,
      400,
      "and the code is spent",
    );
  },
);
