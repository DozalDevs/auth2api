import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { Config, persistApiKeys } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { StatsEvent, StatsRecorder } from "../src/stats/recorder";
import { hashApiKey } from "../src/utils/common";

const KEY = "sk-admin-0123456789abcdef";

function usage(input: number, cached: number, output: number) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached,
    reasoningOutputTokens: 0,
  };
}

function input(
  over: Partial<Omit<StatsEvent, "v" | "ts">>,
): Omit<StatsEvent, "v" | "ts"> {
  return {
    apiKeyHash: hashApiKey(KEY),
    ip: "10.0.0.1",
    ua: "t",
    endpoint: "POST /v1/responses",
    model: "gpt-6-luna",
    provider: "codex",
    accountEmail: "a@b.c",
    status: "success",
    failureKind: null,
    statusCode: 200,
    latencyMs: 10,
    usage: usage(100, 0, 10),
    ...over,
  };
}

function tmpRecorder(t: test.TestContext): StatsRecorder {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-caller-"));
  const recorder = new StatsRecorder();
  recorder.start(dir);
  t.after(async () => {
    await recorder.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return recorder;
}

test("the caller window names each caller with its own totals, biggest first, and starts over once read", (t) => {
  const recorder = tmpRecorder(t);
  recorder.record(
    input({ caller: "dev/sprite:fe3993e", usage: usage(500, 400, 20) }),
  );
  recorder.record(
    input({ caller: "prod/gateway", usage: usage(9000, 8000, 300) }),
  );
  recorder.record(input({ caller: "prod/gateway", usage: usage(1000, 0, 50) }));
  recorder.record(input({ usage: usage(10, 0, 1) }));

  const window = recorder.takeCallerWindow();
  assert.deepEqual(
    window.rows.map((r) => [
      r.caller,
      r.requests,
      r.inputTokens,
      r.cacheReadInputTokens,
      r.outputTokens,
    ]),
    [
      ["prod/gateway", 2, 10000, 8000, 350],
      ["dev/sprite:fe3993e", 1, 500, 400, 20],
      [`untagged key=${hashApiKey(KEY).slice(0, 12)}`, 1, 10, 0, 1],
    ],
  );
  assert.ok(Date.parse(window.from) <= Date.parse(window.to));

  const lines = recorder.formatCallerWindow(window);
  assert.match(lines[0], /caller stats/);
  assert.match(
    lines[1],
    /caller=prod\/gateway: requests=2, .*input_tokens=10000, .*cache_read=8000, .*output_tokens=350/,
  );

  assert.deepEqual(
    recorder.takeCallerWindow().rows,
    [],
    "a read empties the window",
  );
});

test("events replayed from disk at boot never count toward the live caller window", (t) => {
  const recorder = tmpRecorder(t);
  recorder.applyEvent({
    v: 1,
    ts: new Date().toISOString(),
    ...input({ caller: "prod/gateway" }),
  });
  assert.deepEqual(recorder.takeCallerWindow().rows, []);
});

test("a request's X-Relay-Caller header reaches the caller window, cleaned of anything that could break a log line", async (t) => {
  const authDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "auth2api-caller-srv-"),
  );
  const configPath = path.join(authDir, "config.yaml");
  const keys = [{ name: "boss", key: KEY, models: ["*"], admin: true }];
  fs.writeFileSync(configPath, yaml.dump({ port: 1, "api-keys": keys }));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": keys,
    models: [{ id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" }],
    "body-limit": "1mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    stats: { enabled: true },
    debug: "off",
  };
  const recorder = new StatsRecorder();
  recorder.start(authDir);
  const app = createServer(config, buildRegistry(authDir), recorder, {
    persistKeys: persistApiKeys(configPath),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(async () => {
    server.close();
    await recorder.stop();
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  const port = (server.address() as any).port;
  const send = async (caller?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        ...(caller === undefined ? {} : { "x-relay-caller": caller }),
      },
      body: JSON.stringify({
        model: "gpt-6-luna",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await res.text();
  };

  await send("dev/local:abc");
  await send("prod/gw x=" + "y".repeat(200));
  await send();

  const callers = recorder
    .takeCallerWindow()
    .rows.map((r) => r.caller)
    .sort();
  assert.deepEqual(callers, [
    "dev/local:abc",
    ("prod/gw_x=" + "y".repeat(200)).slice(0, 80),
    `untagged key=${hashApiKey(KEY).slice(0, 12)}`,
  ]);
});
