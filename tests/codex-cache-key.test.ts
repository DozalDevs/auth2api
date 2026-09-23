import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  callCodexResponses,
  __buildCodexHeaders,
  __conversationCacheKey,
} from "../src/upstream/codex-api";
import { chatToResponsesRequest } from "../src/upstream/responses-translator";
import type { Config } from "../src/config";
import type { AvailableAccount } from "../src/accounts/manager";

const config: Config = {
  host: "127.0.0.1",
  port: 0,
  "auth-dir": "/tmp",
  "api-keys": new Set(["k"]),
  "body-limit": "1mb",
  cloaking: { "cli-version": "2.1.88", entrypoint: "cli", codex: {} },
  timeouts: {
    "messages-ms": 1000,
    "stream-messages-ms": 1000,
    "count-tokens-ms": 1000,
  },
  debug: "off",
};

const account: AvailableAccount = {
  token: {
    accessToken: "at",
    refreshToken: "rt",
    email: "x@y.z",
    expiresAt: "2030-01-01T00:00:00.000Z",
    accountUuid: "acct-uuid",
    provider: "codex",
  },
  deviceId: "dev",
  accountUuid: "acct-uuid",
  provider: "codex",
  chatgptAccountId: "acct-uuid",
};

const KEY_HEADERS = ["session-id", "thread-id", "x-client-request-id"];

function fakeRequest(headers: Record<string, string> = {}, body?: any): any {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: lower, body };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function capture(
  body: any,
  request: any,
  path?: "/codex/responses" | "/codex/responses/compact",
): Promise<Captured> {
  let seen: Captured | undefined;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    seen = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: init?.body as string,
    };
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await callCodexResponses({ body, request, account, config, path });
  } finally {
    globalThis.fetch = orig;
  }
  assert.ok(seen, "fetch was not called");
  return seen;
}

const baseBody = () => ({
  model: "gpt-5.6-luna",
  stream: true,
  store: false,
  instructions: "be brief",
  input: [{ role: "user", content: "hi" }],
});

for (const header of ["session-id", "session_id", "x-session-affinity"]) {
  test(`cache key from the ${header} header is forwarded in body and all three headers`, async () => {
    const out = await capture(
      baseBody(),
      fakeRequest({ [header]: "conv-123" }),
    );
    assert.equal(JSON.parse(out.body).prompt_cache_key, "conv-123");
    for (const h of KEY_HEADERS) assert.equal(out.headers[h], "conv-123", h);
  });
}

test("cache key from body prompt_cache_key is forwarded in body and all three headers", async () => {
  const body = { ...baseBody(), prompt_cache_key: "conv-body" };
  const out = await capture(body, fakeRequest());
  assert.equal(JSON.parse(out.body).prompt_cache_key, "conv-body");
  for (const h of KEY_HEADERS) assert.equal(out.headers[h], "conv-body", h);
});

test("a header key wins over a differing body key, and body + headers agree", async () => {
  const body = { ...baseBody(), prompt_cache_key: "from-body" };
  const out = await capture(body, fakeRequest({ "session-id": "from-header" }));
  assert.equal(JSON.parse(out.body).prompt_cache_key, "from-header");
  for (const h of KEY_HEADERS) assert.equal(out.headers[h], "from-header", h);
});

test("no key supplied: outgoing request is byte-identical to the pre-change shape", async () => {
  const body = baseBody();
  const expectedBody = JSON.stringify(body);
  const out = await capture(body, fakeRequest({ "user-agent": "pi" }));
  assert.equal(out.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(out.body, expectedBody);
  assert.deepEqual(out.headers, __buildCodexHeaders(account, true, config));
  assert.deepEqual(body, JSON.parse(expectedBody), "caller body not mutated");
});

test("blank or non-string keys count as no key (nothing invented)", async () => {
  const body = { ...baseBody(), prompt_cache_key: 42 };
  const expectedBody = JSON.stringify(body);
  const out = await capture(body, fakeRequest({ "session-id": "   " }));
  assert.equal(out.body, expectedBody);
  for (const h of KEY_HEADERS) assert.equal(out.headers[h], undefined, h);
});

test("the caller's body object is not mutated when a key is added", async () => {
  const body = baseBody();
  await capture(body, fakeRequest({ "session-id": "k1" }));
  assert.equal((body as any).prompt_cache_key, undefined);
});

test("compact path is unchanged: underscore seed headers, no hyphenated key headers, body untouched", async () => {
  const body = { model: "gpt-5.6-luna", input: [] };
  const out = await capture(
    body,
    fakeRequest({ session_id: "s-1", "session-id": "hy-1" }),
    "/codex/responses/compact",
  );
  assert.equal(
    out.url,
    "https://chatgpt.com/backend-api/codex/responses/compact",
  );
  assert.equal(out.body, JSON.stringify(body));
  assert.equal(out.headers.session_id, "s-1");
  assert.equal(out.headers.conversation_id, "s-1");
  assert.equal(out.headers["thread-id"], undefined);
  assert.equal(out.headers["x-client-request-id"], undefined);
  assert.equal(out.headers["session-id"], undefined);
});

test("a 64-char key passes verbatim; a 65-char key is hashed to exactly 64 chars", () => {
  const k64 = "a".repeat(64);
  assert.equal(
    __conversationCacheKey(fakeRequest({ "session-id": k64 }), {}),
    k64,
  );
  const k65 = "a".repeat(65);
  const got = __conversationCacheKey(fakeRequest({ "session-id": k65 }), {});
  assert.equal(got.length, 64);
  assert.equal(got, createHash("sha256").update(k65).digest("hex"));
});

test("long keys sharing a 64-char prefix stay distinct (hash, never truncate)", () => {
  const prefix = "p".repeat(64);
  const a = __conversationCacheKey(fakeRequest(), {
    prompt_cache_key: prefix + "A",
  });
  const b = __conversationCacheKey(fakeRequest(), {
    prompt_cache_key: prefix + "B",
  });
  assert.notEqual(a, b);
  assert.equal(
    a,
    __conversationCacheKey(fakeRequest(), { prompt_cache_key: prefix + "A" }),
    "stable across turns",
  );
});

test("a key with header-unsafe characters is hashed so fetch never sees them", async () => {
  const body = { ...baseBody(), prompt_cache_key: "conv\r\nx-evil: 1 ünïcode" };
  const out = await capture(body, fakeRequest());
  const key = JSON.parse(out.body).prompt_cache_key;
  assert.match(key, /^[0-9a-f]{64}$/);
  for (const h of KEY_HEADERS) assert.equal(out.headers[h], key, h);
});

test("chatToResponsesRequest carries prompt_cache_key across the translation", () => {
  const out = chatToResponsesRequest({
    model: "gpt-5.6-luna",
    prompt_cache_key: "chat-conv",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.prompt_cache_key, "chat-conv");
  const none = chatToResponsesRequest({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal("prompt_cache_key" in none, false);
});
