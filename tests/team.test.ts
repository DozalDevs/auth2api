import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import yaml from "js-yaml";

import {
  ApiKeyEntry,
  Config,
  loadConfig,
  persistAccessRequests,
  persistAdminInvites,
  persistApiKeys,
  persistCatalog,
  persistDashboardUsers,
  persistInvites,
  persistMembers,
} from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { hashPassword } from "../src/auth/password";

const ADMIN = "sk-admin-0123456789abcdef";
const MARIA = "sk-maria-0123456789abcdef";
const START = Date.parse("2026-10-30T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const SHARED = "shared dashboard password";
const NEW = "a brand new long password";
const PUBLIC = "https://relay.example.com";

function entries(): ApiKeyEntry[] {
  return [
    { name: "boss", key: ADMIN, models: ["*"], admin: true },
    { name: "maria", key: MARIA, models: ["@standard"] },
  ];
}

async function startApp(t: test.TestContext) {
  const clock = { t: START };
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-"));
  const configPath = path.join(authDir, "config.yaml");
  const models = [
    { id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" as const },
  ];
  fs.writeFileSync(configPath, yaml.dump({ "api-keys": entries(), models }));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": entries(),
    models,
    "dashboard-users": [
      {
        username: "victor@example.com",
        "password-hash": await hashPassword(SHARED),
      },
    ],
    "public-url": PUBLIC,
    "body-limit": "1mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    stats: { enabled: false },
    debug: "off",
  } as any;
  const app = createServer(config, buildRegistry(authDir), undefined, {
    persistKeys: persistApiKeys(configPath),
    persistCatalog: persistCatalog(configPath),
    persistRequests: persistAccessRequests(configPath),
    persistMembers: persistMembers(configPath),
    persistInvites: persistInvites(configPath),
    persistDashboardUsers: persistDashboardUsers(configPath),
    persistAdminInvites: persistAdminInvites(configPath),
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
    o: { key?: string; cookie?: string; body?: unknown; csrf?: boolean } = {},
  ) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        "content-type": "application/json",
        ...(o.key ? { authorization: `Bearer ${o.key}` } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...(o.csrf === false
          ? {}
          : o.cookie || p.startsWith("/account")
            ? { "x-relay-csrf": "1" }
            : {}),
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
  const tokenOf = (link: string) => link.split("#invite=")[1];
  const signIn = async (email: string, password: string) =>
    call("POST", "/admin/ui/login", { body: { username: email, password } });
  const invite = (email: string) =>
    call("POST", "/admin/team/invite", { key: ADMIN, body: { email } });
  const join = async (email: string, password = NEW) => {
    const inv = await invite(email);
    const r = await call("POST", "/admin/ui/accept", {
      body: { token: tokenOf(inv.body.link), password },
    });
    assert.equal(r.status, 201, r.text);
    return cookieOf(r);
  };
  return {
    call,
    clock,
    configPath,
    cookieOf,
    tokenOf,
    signIn,
    invite,
    join,
    base,
  };
}

test("an admin invites a teammate to the dashboard; the link makes a personal login that works, and nothing readable is stored", async (t) => {
  const { call, invite, tokenOf, cookieOf, configPath } = await startApp(t);
  const inv = await invite("Leo@Example.com");
  assert.equal(inv.status, 201);
  assert.match(
    inv.body.link,
    new RegExp(`^${PUBLIC}/admin/ui#invite=[A-Za-z0-9_-]{40,}$`),
  );
  assert.equal(inv.body.email, "leo@example.com");
  const token = tokenOf(inv.body.link);

  assert.deepEqual(
    (await call("GET", "/admin/team", { key: ADMIN })).body.invites.map(
      (i: any) => i.email,
    ),
    ["leo@example.com"],
  );
  const short = await call("POST", "/admin/ui/accept", {
    body: { token, password: "short" },
  });
  assert.equal(short.status, 400);

  const ok = await call("POST", "/admin/ui/accept", {
    body: { token, password: NEW },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.username, "leo@example.com");
  assert.match(
    ok.setCookie,
    /^relay_session=[a-f0-9]{64}; Max-Age=43200; HttpOnly; SameSite=Strict; Path=\/admin/,
  );
  const cookie = cookieOf(ok);
  assert.equal(
    (await call("GET", "/admin/keys", { cookie })).status,
    200,
    "the new login is a full dashboard session",
  );

  const team = await call("GET", "/admin/team", { cookie });
  assert.deepEqual(team.body.invites, []);
  assert.deepEqual(
    team.body.admins.map((a: any) => [a.username, a.you]),
    [
      ["victor@example.com", false],
      ["leo@example.com", true],
    ],
    "the list says which one is you",
  );
  assert.equal(
    (await signIn2(call, "leo@example.com", NEW)).status,
    200,
    "and he can sign in again later",
  );

  const saved = fs.readFileSync(configPath, "utf8");
  assert.equal(saved.includes(token), false, "the link is never stored");
  assert.equal(saved.includes(NEW), false, "the password is never stored");
  const cfg = loadConfig(configPath);
  assert.deepEqual(
    cfg["dashboard-users"]!.map((u) => u.username),
    ["victor@example.com", "leo@example.com"],
  );
  assert.deepEqual(cfg["admin-invites"], []);
});

function signIn2(call: any, email: string, password: string) {
  return call("POST", "/admin/ui/login", {
    body: { username: email, password },
  });
}

test("an admin link works once, expires after a week, and a newer one replaces it", async (t) => {
  const { call, clock, invite, tokenOf } = await startApp(t);
  const first = await invite("leo@example.com");
  const second = await invite("leo@example.com");
  assert.equal(
    (
      await call("POST", "/admin/ui/accept", {
        body: { token: tokenOf(first.body.link), password: NEW },
      })
    ).status,
    400,
  );
  clock.t = START + 8 * DAY;
  const late = await call("POST", "/admin/ui/accept", {
    body: { token: tokenOf(second.body.link), password: NEW },
  });
  assert.equal(late.status, 410);

  clock.t = START;
  const again = await invite("leo@example.com");
  assert.equal(
    (
      await call("POST", "/admin/ui/accept", {
        body: { token: tokenOf(again.body.link), password: NEW },
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await call("POST", "/admin/ui/accept", {
        body: { token: tokenOf(again.body.link), password: NEW },
      })
    ).status,
    400,
    "used once",
  );

  const reset = await invite("leo@example.com");
  assert.equal(
    (
      await call("POST", "/admin/ui/accept", {
        body: {
          token: tokenOf(reset.body.link),
          password: "another long password!",
        },
      })
    ).status,
    201,
    "a new link resets the password",
  );
  assert.equal((await signIn2(call, "leo@example.com", NEW)).status, 401);
  assert.equal(
    (await signIn2(call, "leo@example.com", "another long password!")).status,
    200,
  );
  assert.equal((await invite("not an email")).status, 400);
});

test("guessing admin links is limited per address", async (t) => {
  const { call, invite, tokenOf } = await startApp(t);
  const inv = await invite("leo@example.com");
  for (let i = 0; i < 10; i++) {
    assert.equal(
      (
        await call("POST", "/admin/ui/accept", {
          body: { token: "x".repeat(40) + i, password: NEW },
        })
      ).status,
      400,
    );
  }
  const locked = await call("POST", "/admin/ui/accept", {
    body: { token: tokenOf(inv.body.link), password: NEW },
  });
  assert.equal(locked.status, 429);
});

test("teammate sign-ins and dashboard logins stay on their own sides", async (t) => {
  const { call, invite, tokenOf } = await startApp(t);
  const memberInvite = await call("POST", "/admin/keys/maria/invite", {
    key: ADMIN,
    body: { email: "maria@example.com" },
  });
  const adminInvite = await invite("leo@example.com");

  assert.equal(
    (
      await call("POST", "/admin/ui/accept", {
        body: { token: tokenOf(memberInvite.body.link), password: NEW },
      })
    ).status,
    400,
    "a teammate link cannot make an admin",
  );
  assert.equal(
    (
      await call("POST", "/account/api/accept", {
        body: { token: tokenOf(adminInvite.body.link), password: NEW },
      })
    ).status,
    400,
    "an admin link is not a teammate sign-in",
  );

  const mariaJoin = await call("POST", "/account/api/accept", {
    body: { token: tokenOf(memberInvite.body.link), password: NEW },
  });
  const maria = mariaJoin.setCookie.split(";")[0];
  for (const [m, p] of [
    ["GET", "/admin/team"],
    ["POST", "/admin/team/invite"],
    ["DELETE", "/admin/team/victor@example.com"],
  ] as const) {
    const r = await call(m, p, {
      cookie: maria,
      body: m === "POST" ? { email: "x@example.com" } : undefined,
    });
    assert.ok([401, 403].includes(r.status), `${m} ${p} -> ${r.status}`);
  }
  assert.equal(
    (await call("GET", "/admin/team", { key: MARIA })).status,
    403,
    "a key that is not an admin key cannot manage the team",
  );
  assert.equal(
    (
      await call("POST", "/admin/ui/login", {
        body: { username: "maria@example.com", password: NEW },
      })
    ).status,
    401,
    "a teammate password is not a dashboard login",
  );
});

test("removing a dashboard login signs that person out, and the last login cannot be removed", async (t) => {
  const { call, join, signIn } = await startApp(t);
  const leo = await join("leo@example.com");
  assert.equal((await call("GET", "/admin/keys", { cookie: leo })).status, 200);

  assert.equal(
    (await call("DELETE", "/admin/team/leo@example.com", { key: ADMIN }))
      .status,
    204,
  );
  assert.equal(
    (await call("GET", "/admin/keys", { cookie: leo })).status,
    401,
    "his open session stops at once",
  );
  assert.equal(
    (
      await call("POST", "/admin/ui/login", {
        body: { username: "leo@example.com", password: NEW },
      })
    ).status,
    401,
  );
  assert.equal(
    (await call("DELETE", "/admin/team/leo@example.com", { key: ADMIN }))
      .status,
    404,
  );

  const last = await call("DELETE", "/admin/team/victor@example.com", {
    key: ADMIN,
  });
  assert.equal(last.status, 409);
  assert.match(last.body.error.message, /only dashboard login/);
  assert.equal(
    (await signIn("victor@example.com", SHARED)).status,
    200,
    "the shared login still works",
  );
});

test("a waiting admin invite can be cancelled", async (t) => {
  const { call, invite, tokenOf } = await startApp(t);
  const inv = await invite("leo@example.com");
  assert.equal(
    (
      await call("DELETE", "/admin/team/invites/leo@example.com", {
        key: ADMIN,
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await call("DELETE", "/admin/team/invites/leo@example.com", {
        key: ADMIN,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call("POST", "/admin/ui/accept", {
        body: { token: tokenOf(inv.body.link), password: NEW },
      })
    ).status,
    400,
  );
});

test("config check: a malformed admin invite is refused at start", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(
    file,
    yaml.dump({
      "api-keys": entries(),
      "admin-invites": [
        {
          "token-hash": "nope",
          email: "a@example.com",
          "created-at": "2026-10-30T00:00:00Z",
          "expires-at": "2026-11-06T00:00:00Z",
        },
      ],
    }),
  );
  assert.throws(() => loadConfig(file), /token-hash must be a sha256/);
});
