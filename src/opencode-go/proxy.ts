import crypto from "crypto";
import express from "express";
import { Config } from "../config";
import { GoKeyPool } from "./pool";
import { UsageScanner } from "./usage";

/** Go models are addressed as go/<id> so they never collide with the same id on another provider. */
export const GO_PREFIX = "go/";
export const DEFAULT_GO_BASE = "https://opencode.ai/inference/go";

export type GoKind = "chat" | "responses" | "messages" | "count";

const PATHS: Record<GoKind, string> = {
  chat: "/openai/v1/chat/completions",
  responses: "/openai/v1/responses",
  messages: "/anthropic/v1/messages",
  count: "/anthropic/v1/messages/count_tokens",
};

/** Statuses that mean "this key cannot serve this right now": try the next key. */
const NEXT_KEY = new Set([401, 402, 403, 429]);

export function isGoModel(model: unknown): model is string {
  return (
    typeof model === "string" &&
    model.startsWith(GO_PREFIX) &&
    model.length > GO_PREFIX.length
  );
}

export function goBase(config: Config): string {
  return (config["opencode-go"]?.["base-url"] ?? DEFAULT_GO_BASE).replace(
    /\/+$/,
    "",
  );
}

/** Headers Go expects from a relay: who we are, and a stable session id so it can route and cache. */
export function goRequestHeaders(
  req: express.Request,
  res: express.Response,
): Record<string, string> {
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: typeof req.headers.accept === "string" ? req.headers.accept : "*/*",
    // Go asks clients to identify themselves rather than look like a generic HTTP library.
    "user-agent": "dozaldevs-relay/1.0",
  };
  // Go refuses a request with no session id, so every request carries one: the
  // caller's own if it sent one, otherwise a stable id for that caller, so Go
  // can still route and cache sensibly.
  const sessionOk = (v: unknown): v is string =>
    typeof v === "string" && /^[\x21-\x7e]{1,200}$/.test(v);
  const claude = req.headers["x-claude-code-session-id"];
  const given = [req.headers["x-opencode-session"], claude].find(sessionOk);
  const caller =
    (res.locals.keyEntry as { name?: string } | undefined)?.name ?? "anonymous";
  baseHeaders["x-opencode-session"] =
    given ??
    `relay-${crypto.createHash("sha256").update(caller).digest("hex").slice(0, 16)}`;
  if (sessionOk(claude)) baseHeaders["x-claude-code-session-id"] = claude;
  for (const h of ["anthropic-version", "anthropic-beta"]) {
    const v = req.headers[h];
    if (typeof v === "string" && /^[\x20-\x7e]{1,200}$/.test(v))
      baseHeaders[h] = v;
  }
  return baseHeaders;
}

/**
 * Sends a request for a go/<model> straight to OpenCode Go with a key from the
 * pool. Go speaks the OpenAI, Responses and Anthropic formats itself, so the
 * body goes through untouched apart from the model name. Token usage is read
 * off the reply so each person's daily limit and the usage report still work.
 */
export function createGoHandler(
  config: Config,
  pool: GoKeyPool,
  kind: GoKind,
): express.RequestHandler {
  return async (req, res) => {
    const model = req.body.model as string;
    const upstreamModel = model.slice(GO_PREFIX.length);
    const stats = res.locals.stats as Record<string, any> | undefined;
    if (stats) {
      stats.model = model;
      stats.provider = "opencode-go";
    }
    const fail = (status: number, type: string, message: string) => {
      if (stats) stats.failureKind = type;
      res.status(status).json({ error: { message, type } });
    };

    if (pool.size === 0) {
      fail(
        503,
        "provider_not_connected",
        "OpenCode Go is not connected on this relay.",
      );
      return;
    }

    const body: Record<string, any> = { ...req.body, model: upstreamModel };
    if (kind === "chat" && body.stream === true) {
      body.stream_options = {
        ...(body.stream_options && typeof body.stream_options === "object"
          ? body.stream_options
          : {}),
        include_usage: true,
      };
    }
    const payload = JSON.stringify(body);
    const baseHeaders = goRequestHeaders(req, res);

    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) gone.abort();
    });
    const limitMs =
      body.stream === true
        ? config.timeouts["stream-messages-ms"]
        : config.timeouts["messages-ms"];
    const signal = AbortSignal.any([gone.signal, AbortSignal.timeout(limitMs)]);

    const call = await callGo({
      config,
      pool,
      upstreamModel,
      kind,
      payload,
      headers: baseHeaders,
      signal,
      gone: gone.signal,
    });
    if (call.kind === "aborted") return;
    if (call.kind === "reply") {
      if (stats) stats.accountEmail = pool.label(call.index);
      await relayReply(call.up, res, stats);
      return;
    }
    if (call.kind === "refused") {
      // Every key was refused. Pass Go's own explanation through: it says whether
      // this is a usage limit, a bad key or a privacy setting on the workspace.
      if (stats) stats.failureKind = `upstream_${call.status}`;
      res.status(call.status).type(call.type).send(call.text);
      return;
    }
    fail(
      502,
      "upstream_unreachable",
      "Could not reach OpenCode Go. Try again in a moment.",
    );
  };
}

export type GoCall =
  | { kind: "reply"; up: Response; index: number }
  | { kind: "refused"; status: number; type: string; text: string }
  | { kind: "unreachable" }
  | { kind: "aborted" };

/**
 * Sends one request to Go, starting on the key that last worked for this model
 * and moving to the next only when Go refuses a key (401, 402, 403 or 429).
 */
export async function callGo(o: {
  config: Config;
  pool: GoKeyPool;
  upstreamModel: string;
  kind: GoKind;
  payload: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  gone?: AbortSignal;
}): Promise<GoCall> {
  const url = `${goBase(o.config)}${PATHS[o.kind]}`;
  let refused: { status: number; type: string; text: string } | null = null;
  for (const index of o.pool.order(o.upstreamModel)) {
    const headers: Record<string, string> = {
      ...o.headers,
      authorization: `Bearer ${o.pool.key(index)}`,
    };
    if (o.kind === "messages" || o.kind === "count")
      headers["x-api-key"] = o.pool.key(index);
    let up: Response;
    try {
      up = await fetch(url, {
        method: "POST",
        headers,
        body: o.payload,
        signal: o.signal,
      });
    } catch {
      if (o.gone?.aborted) return { kind: "aborted" };
      o.pool.note(index, 0);
      continue;
    }
    o.pool.note(index, up.status);
    if (NEXT_KEY.has(up.status)) {
      refused = {
        status: up.status,
        type: up.headers.get("content-type") ?? "application/json",
        text: await up.text().catch(() => ""),
      };
      continue;
    }
    if (up.status < 400) o.pool.markGood(o.upstreamModel, index);
    return { kind: "reply", up, index };
  }
  return refused ? { kind: "refused", ...refused } : { kind: "unreachable" };
}

async function relayReply(
  up: Response,
  res: express.Response,
  stats: Record<string, any> | undefined,
): Promise<void> {
  const contentType = up.headers.get("content-type") ?? "application/json";
  const scanner = new UsageScanner();
  res.status(up.status).setHeader("content-type", contentType);
  const requestId = up.headers.get("x-request-id");
  if (requestId) res.setHeader("x-request-id", requestId);

  if (!contentType.includes("text/event-stream") || !up.body) {
    const buf = Buffer.from(await up.arrayBuffer());
    scanner.whole(buf.toString("utf8"));
    if (stats) stats.usage = scanner.usage();
    res.end(buf);
    return;
  }

  res.setHeader("cache-control", "no-cache");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
  const reader = up.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      scanner.feed(value);
      if (!res.write(value))
        await new Promise<void>((r) => res.once("drain", () => r()));
    }
  } catch {
    // The caller left or Go dropped the stream: keep whatever usage was seen.
  }
  scanner.end();
  if (stats) stats.usage = scanner.usage();
  res.end();
}
