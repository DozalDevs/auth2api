import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { AddressInfo } from "node:net";

import { Config } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { KEYS, startMockRelay } from "./helpers/mock-relay";

const SETUP_DIR = path.resolve(__dirname, "..", "setup");
const IS_WINDOWS = process.platform === "win32";
const TEST_DATE = "2026-10-28";
const dayOffset = (days: number) =>
  new Date(Date.parse(TEST_DATE) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

// OpenCode 2.x lists a model in its picker only when it is released within about six months and is the newest of
// its family for that provider. Copied from the app's own rule so a regression here shows up in CI.
const SIX_MONTHS_MS = 6 * 30.436875 * 24 * 60 * 60 * 1000;
function modelsTheAppWouldShow(
  cfg: any,
  providerId: string,
  now: number,
): string[] {
  const models = Object.entries(cfg.providers?.[providerId]?.models ?? {}) as [
    string,
    any,
  ][];
  const recent = models.filter(
    ([, m]) => Math.abs(now - Date.parse(m.releaseDate)) < SIX_MONTHS_MS,
  );
  const newestPerFamily = new Map<string, [string, any]>();
  for (const entry of recent) {
    const family = String(entry[1].family);
    const best = newestPerFamily.get(family);
    if (!best || entry[1].releaseDate > best[1].releaseDate)
      newestPerFamily.set(family, entry);
  }
  return [...newestPerFamily.values()].map(([id]) => id);
}

function which(cmd: string): string | null {
  try {
    const out = execFileSync(IS_WINDOWS ? "where" : "which", [cmd], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

interface Runner {
  name: string;
  checkFlag: string;
  command(args: string[]): { cmd: string; args: string[] };
}

const runners: Runner[] = [];
if (!IS_WINDOWS && which("bash")) {
  runners.push({
    name: "bash",
    checkFlag: "--check",
    command: (a) => ({
      cmd: "/bin/bash",
      args: [path.join(SETUP_DIR, "setup-opencode.sh"), ...a],
    }),
  });
}
if (which("pwsh")) {
  runners.push({
    name: "pwsh",
    checkFlag: "-Check",
    command: (a) => ({
      cmd: "pwsh",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(SETUP_DIR, "setup-opencode.ps1"),
        ...a,
      ],
    }),
  });
}
if (IS_WINDOWS && which("powershell")) {
  runners.push({
    name: "windows-powershell",
    checkFlag: "-Check",
    command: (a) => ({
      cmd: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(SETUP_DIR, "setup-opencode.ps1"),
        ...a,
      ],
    }),
  });
}

interface Sandbox {
  config: string;
  data: string;
  configFile: string;
  keyFile: string;
  root: string;
}

function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-test-"));
  const config = path.join(root, "config");
  const data = path.join(root, "data");
  fs.mkdirSync(path.join(config, "opencode"), { recursive: true });
  fs.mkdirSync(path.join(data, "opencode"), { recursive: true });
  return {
    root,
    config,
    data,
    configFile: path.join(config, "opencode", "opencode.json"),
    keyFile: path.join(data, "opencode", "dozaldevs-relay.key"),
  };
}

function run(
  r: Runner,
  sb: Sandbox,
  relayUrl: string,
  key: string | undefined,
  args: string[] = [],
  date = TEST_DATE,
) {
  const { cmd, args: argv } = r.command(args);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: sb.config,
    XDG_DATA_HOME: sb.data,
    RELAY_URL: relayUrl,
    RELAY_RELEASE_DATE: date,
  };
  if (key !== undefined) env.RELAY_API_KEY = key;
  else delete env.RELAY_API_KEY;
  return exec(cmd, argv, env);
}

function exec(
  cmd: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  input = "",
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf-8"));
const files = (sb: Sandbox) => {
  const out: string[] = [];
  for (const dir of [sb.config, sb.data]) {
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        e.isDirectory() ? walk(p) : out.push(p);
      }
    };
    walk(dir);
  }
  return out;
};
const expectedKeyRef = (sb: Sandbox) =>
  `{file:${sb.keyFile.replace(/\\/g, "/")}}`;

if (runners.length === 0) {
  test("no script runner available on this machine", { skip: true }, () => {});
}

for (const r of runners) {
  test(`${r.name}: a clean setup writes the key file and a provider that points at it`, async (t) => {
    const relay = await startMockRelay();
    const sb = sandbox();
    t.after(() => relay.close());
    const res = await run(r, sb, relay.url, KEYS.luna);
    assert.equal(res.code, 0, res.out);
    assert.match(
      res.out,
      /All set\. Models you can use: gpt-6-luna gpt-5\.6-luna/,
    );
    assert.equal(fs.readFileSync(sb.keyFile, "utf-8"), KEYS.luna);
    const raw = fs.readFileSync(sb.configFile);
    assert.notEqual(raw[0], 0xef, "no byte-order mark");
    const cfg = JSON.parse(raw.toString("utf-8"));
    assert.equal(cfg.$schema, "https://opencode.ai/config.json");
    assert.equal(cfg.model, "dozaldevs-relay/gpt-6-luna");
    const p = cfg.provider["dozaldevs-relay"];
    assert.equal(p.npm, "@ai-sdk/openai-compatible");
    assert.equal(p.options.baseURL, `${relay.url}/v1`);
    assert.equal(p.options.apiKey, expectedKeyRef(sb));
    assert.deepEqual(Object.keys(p.models), ["gpt-6-luna", "gpt-5.6-luna"]);
    assert.equal(p.models["gpt-6-luna"].name, "GPT-6 Luna");
    assert.equal(p.models["gpt-5.6-luna"].name, "GPT-5.6 Luna");
    assert.equal(
      raw.toString("utf-8").includes(KEYS.luna),
      false,
      "no secret in the settings file",
    );
    assert.equal(
      res.out.includes(KEYS.luna),
      false,
      "the key is never printed",
    );
    if (!IS_WINDOWS) assert.equal(fs.statSync(sb.keyFile).mode & 0o777, 0o600);
  });

  test(`${r.name}: running it again changes nothing and leaves no backup`, async (t) => {
    const relay = await startMockRelay();
    const sb = sandbox();
    t.after(() => relay.close());
    assert.equal((await run(r, sb, relay.url, KEYS.luna)).code, 0);
    const before = files(sb).map((f) => [f, fs.readFileSync(f, "utf-8")]);
    const again = await run(r, sb, relay.url, KEYS.luna);
    assert.equal(again.code, 0, again.out);
    assert.equal((again.out.match(/unchanged/g) || []).length, 2, again.out);
    assert.deepEqual(
      files(sb).map((f) => [f, fs.readFileSync(f, "utf-8")]),
      before,
    );
  });

  test(`${r.name}: --check proves the setup and changes nothing, and refuses before setup`, async (t) => {
    const relay = await startMockRelay();
    const sb = sandbox();
    t.after(() => relay.close());
    const early = await run(r, sb, relay.url, undefined, [r.checkFlag]);
    assert.equal(early.code, 1, early.out);
    assert.match(early.out, /Check failed: no saved key/);
    assert.equal(files(sb).length, 0);

    assert.equal((await run(r, sb, relay.url, KEYS.luna)).code, 0);
    const before = files(sb).map((f) => [f, fs.readFileSync(f, "utf-8")]);
    const ok = await run(r, sb, relay.url, undefined, [r.checkFlag]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(
      ok.out,
      /Check passed\. Models you can use: gpt-6-luna gpt-5\.6-luna/,
    );
    assert.equal(ok.out.includes(KEYS.luna), false);
    assert.deepEqual(
      files(sb).map((f) => [f, fs.readFileSync(f, "utf-8")]),
      before,
    );

    fs.writeFileSync(sb.configFile, JSON.stringify({ model: "x" }));
    const broken = await run(r, sb, relay.url, undefined, [r.checkFlag]);
    assert.equal(broken.code, 1);
    assert.match(broken.out, /not set up for the relay yet/);
  });

  test(`${r.name}: a wrong key, a disabled key and an unreachable relay stop without writing anything`, async (t) => {
    const relay = await startMockRelay();
    t.after(() => relay.close());
    for (const [key, url, expected] of [
      [
        "sk-nope-0123456789abcdef0123",
        relay.url,
        /rejected your key \(Invalid API key\)/,
      ],
      [KEYS.off, relay.url, /rejected your key \(API key disabled\)/],
      [KEYS.luna, "http://127.0.0.1:1", /could not reach/],
      ["sk-short", relay.url, /too short/],
    ] as const) {
      const sb = sandbox();
      const res = await run(r, sb, url, key);
      assert.equal(res.code, 1, res.out);
      assert.match(res.out, expected);
      assert.match(res.out, /Nothing was changed/);
      assert.equal(files(sb).length, 0, `${key}: wrote files`);
    }
  });

  test(`${r.name}: existing settings survive, including deeply nested ones, with a backup`, async (t) => {
    const relay = await startMockRelay();
    const sb = sandbox();
    t.after(() => relay.close());
    const original = {
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-sonnet-5-5",
      autoupdate: false,
      enabled_providers: ["anthropic"],
      provider: { anthropic: { options: { timeout: 1 } }, other: { npm: "x" } },
      permission: { bash: { "*": "ask", "rm -rf *": "deny" } },
      deep: { a: { b: { c: { d: { e: { f: { g: "kept" } } } } } } },
      list: [1, 2, 3],
      single: ["only"],
    };
    fs.writeFileSync(sb.configFile, JSON.stringify(original, null, 2));
    const res = await run(r, sb, relay.url, KEYS.luna);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /default model was left as it was/);
    const cfg = readJson(sb.configFile);
    assert.equal(cfg.model, "anthropic/claude-sonnet-5-5");
    assert.equal(cfg.autoupdate, false);
    assert.deepEqual(cfg.enabled_providers, ["anthropic", "dozaldevs-relay"]);
    assert.deepEqual(cfg.provider.anthropic, original.provider.anthropic);
    assert.deepEqual(cfg.provider.other, original.provider.other);
    assert.deepEqual(cfg.permission, original.permission);
    assert.deepEqual(cfg.deep, original.deep);
    assert.deepEqual(cfg.list, [1, 2, 3]);
    assert.deepEqual(cfg.single, ["only"]);
    assert.ok(cfg.provider["dozaldevs-relay"]);
    const backups = fs
      .readdirSync(path.dirname(sb.configFile))
      .filter((f) => f.includes(".bak-"));
    assert.equal(backups.length, 1);
    assert.deepEqual(
      readJson(path.join(path.dirname(sb.configFile), backups[0])),
      original,
    );
  });

  test(`${r.name}: every relay model is switched on in OpenCode's model menu by default`, async (t) => {
    const relay = await startMockRelay();
    const sb = sandbox();
    t.after(() => relay.close());
    assert.equal((await run(r, sb, relay.url, KEYS.wide)).code, 0);
    const cfg = readJson(sb.configFile);
    const ids = Object.keys(cfg.provider["dozaldevs-relay"].models);
    const entry = cfg.providers["dozaldevs-relay"].models;
    assert.deepEqual(Object.keys(entry), ids);
    const block = cfg.providers["dozaldevs-relay"];
    assert.equal(
      block.package,
      "@opencode/ai/providers/openai-compatible",
      "2.x needs the connection in this block",
    );
    assert.equal(block.name, "DozalDevs ChatGPT Relay");
    assert.equal(block.settings.baseURL, `${relay.url}/v1`);
    assert.equal(block.settings.apiKey, expectedKeyRef(sb));
    assert.equal(
      block.settings.apiKey,
      cfg.provider["dozaldevs-relay"].options.apiKey,
      "both blocks use the same key file",
    );
    for (const id of ids) {
      assert.equal(entry[id].releaseDate, TEST_DATE, id);
      assert.equal(entry[id].family, id, "each model is its own family");
      assert.equal(
        entry[id].name,
        cfg.provider["dozaldevs-relay"].models[id].name,
        "same display name in both blocks",
      );
    }
    assert.deepEqual(
      modelsTheAppWouldShow(
        cfg,
        "dozaldevs-relay",
        Date.parse(TEST_DATE) + 3_600_000,
      ).sort(),
      [...ids].sort(),
    );
    assert.equal(
      modelsTheAppWouldShow(
        cfg,
        "dozaldevs-relay",
        Date.parse(TEST_DATE) + 400 * 86_400_000,
      ).length,
      0,
      "and they age out",
    );
  });

  test(`${r.name}: other providers in the new-style block are kept`, async (t) => {
    const relay = await startMockRelay();
    const sb = sandbox();
    t.after(() => relay.close());
    const mine = {
      providers: {
        acme: { name: "Acme", models: { x: { name: "X" } } },
        "dozaldevs-relay": { models: { stale: { name: "Stale" } } },
      },
    };
    fs.writeFileSync(sb.configFile, JSON.stringify(mine, null, 2));
    assert.equal((await run(r, sb, relay.url, KEYS.luna)).code, 0);
    const cfg = readJson(sb.configFile);
    assert.deepEqual(cfg.providers.acme, mine.providers.acme);
    assert.deepEqual(Object.keys(cfg.providers["dozaldevs-relay"].models), [
      "gpt-6-luna",
      "gpt-5.6-luna",
    ]);
  });

  test(`${r.name}: --check warns before the models drop out of the menu, and after an old setup`, async (t) => {
    const relay = await startMockRelay();
    const sb = sandbox();
    t.after(() => relay.close());
    assert.equal((await run(r, sb, relay.url, KEYS.luna)).code, 0);

    const fresh = await run(
      r,
      sb,
      relay.url,
      undefined,
      [r.checkFlag],
      dayOffset(149),
    );
    assert.equal(fresh.code, 0, fresh.out);
    assert.match(fresh.out, /set to show in OpenCode's model menu/);

    const stale = await run(
      r,
      sb,
      relay.url,
      undefined,
      [r.checkFlag],
      dayOffset(151),
    );
    assert.equal(stale.code, 1, stale.out);
    assert.match(stale.out, /drop out of OpenCode's model menu/);
    assert.match(stale.out, /Run the setup again/);

    const cfg = readJson(sb.configFile);
    delete cfg.providers;
    fs.writeFileSync(sb.configFile, JSON.stringify(cfg, null, 2));
    const oldStyle = await run(r, sb, relay.url, undefined, [r.checkFlag]);
    assert.equal(oldStyle.code, 1, oldStyle.out);
    assert.match(oldStyle.out, /out of date\. Run the setup again/);

    assert.equal(
      (await run(r, sb, relay.url, KEYS.luna, [], dayOffset(151))).code,
      0,
    );
    assert.equal(
      (await run(r, sb, relay.url, undefined, [r.checkFlag], dayOffset(151)))
        .code,
      0,
    );
  });

  test(`${r.name}: a key allowed more models lists exactly the ones the relay serves, cheapest first`, async (t) => {
    const relay = await startMockRelay();
    const sb = sandbox();
    t.after(() => relay.close());
    const res = await run(r, sb, relay.url, KEYS.wide);
    assert.equal(res.code, 0, res.out);
    const cfg = readJson(sb.configFile);
    assert.deepEqual(Object.keys(cfg.provider["dozaldevs-relay"].models), [
      "gpt-6-luna",
      "gpt-5.6-luna",
      "gpt-6-sol",
      "gpt-5.6-sol",
      "gpt-6-astra",
    ]);
    assert.equal(cfg.model, "dozaldevs-relay/gpt-6-luna");
    assert.equal(
      cfg.provider["dozaldevs-relay"].models["gpt-6-astra"].name,
      "GPT-6 Astra",
    );
  });

  test(`${r.name}: a key at its daily limit is still set up, with a warning`, async (t) => {
    const relay = await startMockRelay();
    const sb = sandbox();
    t.after(() => relay.close());
    const res = await run(r, sb, relay.url, KEYS.capped);
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /daily limit is used up/);
    assert.deepEqual(
      Object.keys(readJson(sb.configFile).provider["dozaldevs-relay"].models),
      ["gpt-6-luna", "gpt-5.6-luna"],
    );
  });

  test(`${r.name}: a settings file that is not JSON is never touched, and nothing is saved`, async (t) => {
    const relay = await startMockRelay();
    t.after(() => relay.close());
    for (const text of ["not json at all", '{ "model": ', "[1,2,3]"]) {
      const sb = sandbox();
      fs.writeFileSync(sb.configFile, text);
      const res = await run(r, sb, relay.url, KEYS.luna);
      assert.equal(res.code, 1, `${text}: ${res.out}`);
      assert.match(res.out, /is not plain JSON/);
      assert.equal(fs.readFileSync(sb.configFile, "utf-8"), text);
      assert.equal(fs.existsSync(sb.keyFile), false);
      assert.equal(
        res.out.includes("Checking your key"),
        false,
        "stopped before talking to the relay",
      );
    }
  });

  test(`${r.name}: a replaced key and a stale default model are corrected on re-run`, async (t) => {
    const relay = await startMockRelay();
    const sb = sandbox();
    t.after(() => relay.close());
    assert.equal((await run(r, sb, relay.url, KEYS.wide)).code, 0);
    const cfg = readJson(sb.configFile);
    cfg.model = "dozaldevs-relay/gpt-6-astra";
    fs.writeFileSync(sb.configFile, JSON.stringify(cfg, null, 2));
    assert.equal((await run(r, sb, relay.url, KEYS.luna)).code, 0);
    assert.equal(readJson(sb.configFile).model, "dozaldevs-relay/gpt-6-luna");
    assert.equal(fs.readFileSync(sb.keyFile, "utf-8"), KEYS.luna);
  });

  test(`${r.name}: a key pasted with spaces and line breaks still works`, async (t) => {
    const relay = await startMockRelay();
    const sb = sandbox();
    t.after(() => relay.close());
    const res = await run(r, sb, relay.url, `  ${KEYS.luna}\r\n`);
    assert.equal(res.code, 0, res.out);
    assert.equal(fs.readFileSync(sb.keyFile, "utf-8"), KEYS.luna);
  });
}

if (runners.length > 1) {
  test("every runner produces the same settings for the same key", async (t) => {
    const relay = await startMockRelay();
    t.after(() => relay.close());
    const results: string[] = [];
    for (const r of runners) {
      const sb = sandbox();
      assert.equal((await run(r, sb, relay.url, KEYS.wide)).code, 0);
      const cfg = readJson(sb.configFile);
      cfg.provider["dozaldevs-relay"].options.apiKey = "<key file>";
      cfg.providers["dozaldevs-relay"].settings.apiKey = "<key file>";
      results.push(JSON.stringify(cfg));
    }
    for (const x of results) assert.equal(x, results[0]);
  });
}

async function startRelayServer(t: test.TestContext) {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-route-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": [
      {
        name: "boss",
        key: "sk-boss-0123456789abcdef",
        models: ["*"],
        admin: true,
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
  return (server.address() as AddressInfo).port;
}

function get(port: number, p: string, headers: Record<string, string> = {}) {
  return new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: p, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("the relay serves the setup files publicly, filled in with its own address", async (t) => {
  const port = await startRelayServer(t);
  const files: [string, string][] = [
    ["/setup/opencode.sh", "setup-opencode.sh"],
    ["/setup/opencode.ps1", "setup-opencode.ps1"],
    ["/setup/prompt.txt", "agent-prompt.txt"],
  ];
  for (const [route, file] of files) {
    const res = await get(port, route, { host: "relay.example.com" });
    assert.equal(res.status, 200, route);
    assert.match(String(res.headers["content-type"]), /^text\/plain/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["cache-control"], "no-store");
    const source = fs.readFileSync(path.join(SETUP_DIR, file), "utf-8");
    assert.equal(
      res.body,
      source.split("__RELAY_URL__").join("http://relay.example.com"),
      route,
    );
    assert.equal(res.body.includes("__RELAY_URL__"), false);
  }
  const secure = await get(port, "/setup/opencode.sh", {
    host: "relay.example.com",
    "x-forwarded-proto": "https",
  });
  assert.match(
    secure.body,
    /RELAY_URL_DEFAULT="https:\/\/relay\.example\.com"/,
  );
  const prompt = await get(port, "/setup/prompt.txt", {
    host: "relay.example.com",
    "x-forwarded-proto": "https",
  });
  assert.match(
    prompt.body,
    /curl -fsSL https:\/\/relay\.example\.com\/setup\/opencode\.sh \| bash/,
  );
  assert.equal((await get(port, "/setup/other.sh")).status, 404);
});

test("the setup files carry no secrets and a forged Host header is refused", async (t) => {
  const port = await startRelayServer(t);
  const bad = await get(port, "/setup/opencode.sh", { host: "evil.com/x y" });
  assert.equal(bad.status, 400);
  for (const route of [
    "/setup/opencode.sh",
    "/setup/opencode.ps1",
    "/setup/prompt.txt",
  ]) {
    const body = (await get(port, route, { host: "relay.example.com" })).body;
    assert.equal(/sk-[0-9a-f]{20,}/.test(body), false, route);
  }
});

test("the prompt tells the agent never to handle the key", () => {
  const prompt = fs.readFileSync(
    path.join(SETUP_DIR, "agent-prompt.txt"),
    "utf-8",
  );
  assert.match(
    prompt,
    /Never ask them to type, paste or\s+show the key in this chat/,
  );
  assert.match(prompt, /setup\/opencode\.sh \| bash -s -- --check/);
  assert.match(prompt, /-Check/);
});

if (!IS_WINDOWS && runners.some((r) => r.name === "bash")) {
  test("a script piped from the relay (curl | bash) talks to the relay it came from", async (t) => {
    const port = await startRelayServer(t);
    const sb = sandbox();
    const served = (
      await get(port, "/setup/opencode.sh", { host: `127.0.0.1:${port}` })
    ).body;
    assert.match(
      served,
      new RegExp(`RELAY_URL_DEFAULT="http://127\\.0\\.0\\.1:${port}"`),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: sb.config,
      XDG_DATA_HOME: sb.data,
      RELAY_API_KEY: "sk-wrong-0123456789abcdef0123",
    };
    delete env.RELAY_URL;
    const res = await exec("/bin/bash", [], env, served);
    const out = res.out;
    assert.equal(res.code, 1, out);
    assert.match(out, /rejected your key \(Invalid API key\)/);
    assert.equal(files(sb).length, 0);
  });
}
