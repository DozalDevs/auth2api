import express from "express";
import { Config, isDebugLevel } from "./config";
import { ProviderRegistry } from "./providers/registry";
import { extractApiKey, hashApiKey } from "./utils/common";
import {
  createChatCompletionsHandler,
  createResponsesCompactHandler,
  createResponsesHandler,
} from "./handlers/openai";
import {
  createMessagesHandler,
  createCountTokensHandler,
} from "./handlers/anthropic";
import { StatsRecorder } from "./stats/recorder";
import { RateLimiter, clientIp } from "./utils/rate-limit";
import { KeyStore } from "./keys/store";
import { registerKeyRoutes, utcDay } from "./keys/routes";
import { ApiKeyEntry } from "./config";

export function createServer(
  config: Config,
  registry: ProviderRegistry,
  statsRecorder?: StatsRecorder,
  opts: { persistKeys?: (entries: ApiKeyEntry[]) => void } = {},
): express.Application {
  const app = express();
  const keyStore = new KeyStore(config["api-keys"], {
    statsEnabled: !!statsRecorder,
    persist: opts.persistKeys,
  });

  app.use(express.json({ limit: config["body-limit"] }));

  if (isDebugLevel(config.debug, "verbose")) {
    app.use((req, res, next) => {
      const startedAt = Date.now();
      console.error(`[debug] ${req.method} ${req.originalUrl} started`);
      res.on("finish", () => {
        console.error(
          `[debug] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${Date.now() - startedAt}ms`,
        );
      });
      next();
    });
  }

  // CORS - restrict to localhost origins only
  const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    if (origin && LOCALHOST_RE.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key",
    );
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Rate limiting middleware — see utils/rate-limit.ts for the keying rules.
  const rateLimiter = new RateLimiter((key) => keyStore.has(key));
  app.use("/v1", (req, res, next) => {
    if (!rateLimiter.allow(req)) {
      res.status(429).json({ error: { message: "Too many requests" } });
      return;
    }
    next();
  });

  // API key auth middleware — accepts both OpenAI style (Authorization: Bearer)
  // and Anthropic style (x-api-key), so Claude Code and OpenAI clients both work
  const requireApiKey: express.RequestHandler = (req, res, next) => {
    const key = extractApiKey(req.headers);
    if (!key) {
      res.status(401).json({ error: { message: "Missing API key" } });
      return;
    }
    const entry = keyStore.authenticate(key);
    if (!entry) {
      res.status(403).json({ error: { message: "Invalid API key" } });
      return;
    }
    if (entry.disabled) {
      res.status(403).json({ error: { message: "API key disabled" } });
      return;
    }
    res.locals.keyEntry = entry;
    // Seed res.locals.stats so the stats-finish middleware can record this
    // request even if the downstream handler aborts before filling in the
    // upstream account / model / usage fields.
    if (statsRecorder) {
      const ip = clientIp(req);
      const ua = (req.headers["user-agent"] as string) || "";
      res.locals.stats = {
        apiKeyHash: hashApiKey(key),
        ip,
        ua,
        endpoint: `${req.method} ${req.baseUrl}${req.path}`,
        startedAt: Date.now(),
        model: null,
        provider: null,
        accountEmail: null,
        usage: null,
        failureKind: null,
      };
    }
    next();
  };

  // Record one stats event per request that made it past auth. `finish`
  // covers normal responses; `close` covers client disconnects before the
  // response completed. A guard prevents the normal finish->close sequence
  // from double-counting.
  const statsFinishMiddleware: express.RequestHandler = (req, res, next) => {
    if (!statsRecorder) return next();
    let recorded = false;
    const recordStats = (override?: {
      status: "success" | "failure";
      statusCode: number;
      failureKind: string | null;
    }) => {
      if (recorded) return;
      recorded = true;
      const ctx = res.locals.stats as
        | {
            apiKeyHash: string;
            ip: string;
            ua: string;
            endpoint: string;
            startedAt: number;
            model: string | null;
            provider: string | null;
            accountEmail: string | null;
            usage: any;
            failureKind: string | null;
          }
        | undefined;
      if (!ctx) return;
      const status: "success" | "failure" =
        override?.status ??
        (res.statusCode >= 200 && res.statusCode < 300 ? "success" : "failure");
      statsRecorder.record({
        apiKeyHash: ctx.apiKeyHash,
        ip: ctx.ip,
        ua: ctx.ua,
        endpoint: ctx.endpoint,
        model: ctx.model,
        provider: ctx.provider as any,
        accountEmail: ctx.accountEmail,
        status,
        failureKind: override?.failureKind ?? ctx.failureKind,
        statusCode: override?.statusCode ?? res.statusCode,
        latencyMs: Date.now() - ctx.startedAt,
        usage: ctx.usage,
      });
    };
    res.on("finish", () => recordStats());
    res.on("close", () => {
      if (!res.writableEnded) {
        recordStats({
          status: "failure",
          statusCode: 499,
          failureKind: "client_disconnect",
        });
      }
    });
    next();
  };

  // Health check (no account count to avoid info leak)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const requireAdmin: express.RequestHandler = (_req, res, next) => {
    if (!(res.locals.keyEntry as ApiKeyEntry).admin) {
      res.status(403).json({ error: { message: "Admin key required" } });
      return;
    }
    next();
  };

  app.use("/admin", requireApiKey);
  app.use("/admin", statsFinishMiddleware);
  app.use("/admin", requireAdmin);
  registerKeyRoutes(app, keyStore, statsRecorder);

  // GET /admin/stats — three-axis aggregated call statistics.
  //   byClient — keyed by sha256(api-key); show short hex prefix to operator
  //   byAccount — keyed by `${provider}:${email}` (upstream OAuth account)
  //   byApi — keyed by `${endpoint}|${model}|${provider}`
  app.get("/admin/stats", (_req, res) => {
    // Limiter 429s are rejected before auth, so they never reach the
    // per-request stats above; report them separately.
    const rateLimited = rateLimiter.snapshot();
    if (!statsRecorder) {
      res.json({ enabled: false, rateLimited });
      return;
    }
    res.json({
      ...statsRecorder.getSnapshot(),
      rateLimited,
      generated_at: new Date().toISOString(),
    });
  });

  app.get("/admin/accounts", (_req, res) => {
    const providers: Record<
      string,
      { accounts: unknown[]; account_count: number }
    > = {};
    for (const p of registry.all()) {
      providers[p.id] = {
        accounts: p.manager.getSnapshots(),
        account_count: p.manager.accountCount,
      };
    }
    res.json({
      providers,
      generated_at: new Date().toISOString(),
    });
  });

  // POST /admin/reload — re-reads token files from auth-dir and reconciles
  // each provider's in-memory state. Called automatically by `--login` after
  // a successful re-auth (see notifyServerReload in src/index.ts), and
  // available for manual use via curl. See AccountManager.reload() for
  // upsert semantics.
  app.post("/admin/reload", async (_req, res) => {
    const reloaded: Record<string, unknown> = {};
    for (const p of registry.all()) {
      try {
        reloaded[p.id] = await p.manager.reload();
      } catch (err: any) {
        reloaded[p.id] = { error: err?.message || String(err) };
      }
    }
    res.json({
      reloaded,
      generated_at: new Date().toISOString(),
    });
  });

  app.use(["/v1", "/codex", "/backend-api/codex"], requireApiKey);
  app.use(["/v1", "/codex", "/backend-api/codex"], statsFinishMiddleware);

  // Per-key policy for calls that consume the subscription: model allowlist
  // (checked after alias resolution) and the daily token cap. Runs after the
  // stats middleware so refused calls still show up in usage reports.
  app.use(["/v1", "/codex", "/backend-api/codex"], (req, res, next) => {
    if (req.method !== "POST") return next();
    const entry = res.locals.keyEntry as ApiKeyEntry;
    const model = req.body?.model;
    if (!entry.models.includes("*")) {
      if (typeof model !== "string" || !model) {
        res.status(400).json({
          error: {
            message: "model is required for this key",
            type: "model_required",
          },
        });
        return;
      }
      if (!keyStore.allows(entry, model)) {
        res.status(403).json({
          error: {
            message: `model "${model}" is not enabled for this key`,
            type: "model_not_allowed",
          },
        });
        return;
      }
    }
    const limit = entry["daily-token-limit"];
    if (
      limit !== undefined &&
      statsRecorder &&
      statsRecorder.tokensOnDay(hashApiKey(entry.key), utcDay()) >= limit
    ) {
      res.status(429).json({
        error: {
          message: "daily token limit reached for this key",
          type: "daily_token_limit",
        },
      });
      return;
    }
    next();
  });
  app.get("/v1/models", async (_req, res) => {
    const entry = res.locals.keyEntry as ApiKeyEntry;
    const created = Math.floor(Date.now() / 1000);
    const providers = registry.withAccounts();
    const lists = await Promise.all(providers.map((p) => p.listModels()));
    const data = lists
      .flatMap((models) =>
        models.map((m) => ({
          id: m.id,
          object: "model",
          created,
          owned_by: m.owned_by,
        })),
      )
      .filter((m) => keyStore.allows(entry, m.id));
    res.json({ object: "list", data });
  });

  // Routes — OpenAI compatible
  app.post(
    "/v1/chat/completions",
    createChatCompletionsHandler(config, registry),
  );
  app.post("/v1/responses", createResponsesHandler(config, registry));
  app.post(
    "/v1/responses/compact",
    createResponsesCompactHandler(config, registry),
  );
  app.post(
    "/codex/responses/compact",
    createResponsesCompactHandler(config, registry),
  );
  app.post(
    "/backend-api/codex/responses/compact",
    createResponsesCompactHandler(config, registry),
  );

  // Routes — Anthropic native passthrough
  app.post("/v1/messages", createMessagesHandler(config, registry));
  app.post(
    "/v1/messages/count_tokens",
    createCountTokensHandler(config, registry),
  );

  return app;
}
