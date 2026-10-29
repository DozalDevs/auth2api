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
    const url = `${goBase(config)}${PATHS[kind]}`;

    const baseHeaders: Record<string, string> = {
      "content-type": "application/json",
      accept:
        typeof req.headers.accept === "string" ? req.headers.accept : "*/*",
      // Go asks clients to identify themselves rather than look like a generic HTTP library.
      "user-agent": "dozaldevs-relay/1.0",
    };
    const session = req.headers["x-opencode-session"];
    if (typeof session === "string" && /^[\x21-\x7e]{1,200}$/.test(session)) {
      baseHeaders["x-opencode-session"] = session;
    }
    for (const h of ["anthropic-version", "anthropic-beta"]) {
      const v = req.headers[h];
      if (typeof v === "string" && /^[\x20-\x7e]{1,200}$/.test(v))
        baseHeaders[h] = v;
    }

    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) gone.abort();
    });
    const limitMs =
      body.stream === true
        ? config.timeouts["stream-messages-ms"]
        : config.timeouts["messages-ms"];
    const signal = AbortSignal.any([gone.signal, AbortSignal.timeout(limitMs)]);

    let refused: { status: number; type: string; text: string } | null = null;
    for (const index of pool.order(upstreamModel)) {
      const headers: Record<string, string> = {
        ...baseHeaders,
        authorization: `Bearer ${pool.key(index)}`,
      };
      if (kind === "messages" || kind === "count")
        headers["x-api-key"] = pool.key(index);
      let up: Response;
      try {
        up = await fetch(url, {
          method: "POST",
          headers,
          body: payload,
          signal,
        });
      } catch {
        if (gone.signal.aborted) return;
        pool.note(index, 0);
        continue;
      }
      pool.note(index, up.status);
      if (NEXT_KEY.has(up.status)) {
        refused = {
          status: up.status,
          type: up.headers.get("content-type") ?? "application/json",
          text: await up.text().catch(() => ""),
        };
        continue;
      }
      pool.markGood(upstreamModel, index);
      if (stats) stats.accountEmail = pool.label(index);
      await relayReply(up, res, stats);
      return;
    }

    if (refused) {
      // Every key was refused. Pass Go's own explanation through: it says whether
      // this is a usage limit, a bad key or a privacy setting on the workspace.
      if (stats) stats.failureKind = `upstream_${refused.status}`;
      res.status(refused.status).type(refused.type).send(refused.text);
      return;
    }
    fail(
      502,
      "upstream_unreachable",
      "Could not reach OpenCode Go. Try again in a moment.",
    );
  };
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
