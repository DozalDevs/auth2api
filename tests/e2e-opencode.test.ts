import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { KEYS, startMockRelay } from "./helpers/mock-relay";

const SETUP_DIR = path.resolve(__dirname, "..", "setup");
const IS_WINDOWS = process.platform === "win32";

function exec(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  shell = false,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env,
      cwd,
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

test(
  "real OpenCode answers through a relay that the setup script configured, with default folders",
  { skip: process.env.E2E_OPENCODE !== "1", timeout: 600_000 },
  async (t) => {
    const relay = await startMockRelay();
    t.after(() => relay.close());
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-home-"));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-work-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      RELAY_URL: relay.url,
      RELAY_API_KEY: KEYS.luna,
    };
    for (const k of Object.keys(env)) if (k.startsWith("XDG_")) delete env[k];

    const setup = IS_WINDOWS
      ? await exec(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.join(SETUP_DIR, "setup-opencode.ps1"),
          ],
          env,
          work,
        )
      : await exec(
          "/bin/bash",
          [path.join(SETUP_DIR, "setup-opencode.sh")],
          env,
          work,
        );
    assert.equal(setup.code, 0, setup.out);

    const paths = await exec(
      "opencode",
      ["debug", "paths"],
      env,
      work,
      IS_WINDOWS,
    );
    console.log(paths.out);
    const configPath = /config\s+(\S.*)/.exec(paths.out)?.[1]?.trim();
    assert.ok(
      configPath,
      `could not read OpenCode's config folder:\n${paths.out}`,
    );
    assert.ok(
      fs.existsSync(path.join(configPath, "opencode.json")),
      `OpenCode reads its settings from ${configPath}, but the script wrote them elsewhere (home: ${home})`,
    );

    const models = await exec(
      "opencode",
      ["models", "dozaldevs-relay"],
      env,
      work,
      IS_WINDOWS,
    );
    assert.match(models.out, /dozaldevs-relay\/gpt-6-luna/, models.out);

    const run = await exec(
      "opencode",
      [
        "run",
        "-m",
        "dozaldevs-relay/gpt-6-luna",
        "Reply with exactly: relay works",
      ],
      env,
      work,
      IS_WINDOWS,
    );
    assert.match(run.out, /relay works/, run.out);
    const chat = relay.calls.filter(
      (c) => c.path === "/v1/chat/completions" && c.model === "gpt-6-luna",
    );
    assert.ok(chat.length > 0, "the relay saw OpenCode's request");
  },
);

test(
  "the OpenCode 2.x engine (desktop app) answers through a relay the setup script configured, and lists every model",
  { skip: !process.env.E2E_OPENCODE_V2, timeout: 600_000 },
  async (t) => {
    const engine = process.env.E2E_OPENCODE_V2 as string;
    const relay = await startMockRelay();
    t.after(() => relay.close());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-v2-"));
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      RELAY_URL: relay.url,
      RELAY_API_KEY: KEYS.wide,
    };
    const setup = await exec(
      "/bin/bash",
      [path.join(SETUP_DIR, "setup-opencode.sh")],
      env,
      work,
    );
    assert.equal(setup.code, 0, setup.out);

    const models = await exec(
      engine,
      ["api", "--standalone", "GET", "/api/model"],
      env,
      work,
    );
    const parsed = JSON.parse(models.out.trim());
    const mine = (parsed.data as any[]).filter(
      (m) => m.providerID === "dozaldevs-relay",
    );
    assert.deepEqual(mine.map((m: any) => m.modelID).sort(), [
      "claude-opus-5-5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
    ]);
    assert.equal(
      mine.find((m: any) => m.modelID === "claude-opus-5-5").name,
      "Claude Opus 5.5 (on request)",
      "a model the key cannot use yet is labelled in the app's own menu",
    );
    for (const m of mine) {
      assert.ok(
        Math.abs(Date.now() - m.time.released) < 6 * 30.436875 * 86_400_000,
        `${m.modelID} looks recent to the app`,
      );
      assert.equal(m.family, m.modelID, "each model is its own family");
    }

    const run = await exec(
      engine,
      [
        "run",
        "--standalone",
        "-m",
        "dozaldevs-relay/gpt-6-luna",
        "Reply with exactly: relay works",
      ],
      env,
      work,
    );
    assert.match(run.out, /relay works/, run.out);
    assert.ok(
      relay.calls.some(
        (c) => c.path === "/v1/chat/completions" && c.model === "gpt-6-luna",
      ),
      "the relay saw the 2.x engine's request",
    );
  },
);
