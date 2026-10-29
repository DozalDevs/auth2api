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
import { ApiKeyEntry, CatalogModel } from "./config";
import { ModelCatalog } from "./models/catalog";
import { resolveModel } from "./upstream/translator";
import { GoKeyPool } from "./opencode-go/pool";
import { createGoHandler, isGoModel } from "./opencode-go/proxy";
import { registerGoAdminRoutes } from "./opencode-go/routes";
import { DASHBOARD_CSP, DASHBOARD_HTML } from "./ui/dashboard";
import { registerSetupRoutes } from "./setup/routes";
import {
  LoginThrottle,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SessionStore,
  checkLogin,
} from "./auth/dashboard-login";

function agoText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "less than a minute ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

export function createServer(
  config: Config,
  registry: ProviderRegistry,
  statsRecorder?: StatsRecorder,
  opts: {
    persistKeys?: (entries: ApiKeyEntry[]) => void;
    persistCatalog?: (models: CatalogModel[]) => void;
    now?: () => number;
  } = {},
): express.Application {
  const app = express();
  const sessions = new SessionStore();
  const loginThrottle = new LoginThrottle();
  const catalog = new ModelCatalog(config.models, {
    persist: opts.persistCatalog,
  });
  const keyStore = new KeyStore(config["api-keys"], {
    statsEnabled: !!statsRecorder,
    persist: opts.persistKeys,
    now: opts.now,
    standardIds: () =>
      catalog
        .list()
        .filter((m) => m.access === "standard")
        .map((m) => m.id),
  });
  const goPool = new GoKeyPool(config["opencode-go"]?.keys ?? []);

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
  const rateLimit: express.RequestHandler = (req, res, next) => {
    if (!rateLimiter.allow(req)) {
      res.status(429).json({ error: { message: "Too many requests" } });
      return;
    }
    next();
  };
  app.use("/v1", rateLimit);
  app.use("/setup/models", rateLimit);

  // Seed res.locals.stats so the stats-finish middleware can record this
  // request even if the downstream handler aborts before filling in the
  // upstream account / model / usage fields.
  const seedStats = (
    req: express.Request,
    res: express.Response,
    secret: string,
  ) => {
    if (!statsRecorder) return;
    res.locals.stats = {
      apiKeyHash: hashApiKey(secret),
      ip: clientIp(req),
      ua: (req.headers["user-agent"] as string) || "",
      endpoint: `${req.method} ${req.baseUrl}${req.path}`,
      startedAt: Date.now(),
      model: null,
      provider: null,
      accountEmail: null,
      usage: null,
      failureKind: null,
    };
  };

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
    seedStats(req, res, key);
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

  registerSetupRoutes(app);

  // Health check (no account count to avoid info leak)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // The page itself holds no secrets and is public; every action it takes
  // goes through the admin-key-gated API below. The CSP only lets its own
  // script and stylesheet run.
  app.get("/admin/ui", (_req, res) => {
    res
      .set({
        "Content-Security-Policy": DASHBOARD_CSP,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      })
      .type("html")
      .send(DASHBOARD_HTML);
  });

  const requireAdmin: express.RequestHandler = (_req, res, next) => {
    if (!(res.locals.keyEntry as ApiKeyEntry).admin) {
      res.status(403).json({ error: { message: "Admin key required" } });
      return;
    }
    next();
  };

  const sessionToken = (req: express.Request): string | undefined =>
    new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})`).exec(
      req.headers.cookie || "",
    )?.[1];

  const cookieFlags = (req: express.Request) =>
    `HttpOnly; SameSite=Strict; Path=/admin${
      req.secure || req.headers["x-forwarded-proto"] === "https"
        ? "; Secure"
        : ""
    }`;

  app.post("/admin/ui/login", async (req, res) => {
    const ip = clientIp(req);
    if (loginThrottle.blocked(ip)) {
      res.status(429).json({
        error: {
          message: "Too many failed attempts. Try again in a few minutes.",
        },
      });
      return;
    }
    const username = await checkLogin(
      config["dashboard-users"] ?? [],
      req.body?.username,
      req.body?.password,
    );
    if (!username) {
      loginThrottle.fail(ip);
      res
        .status(401)
        .json({ error: { message: "Wrong username or password." } });
      return;
    }
    loginThrottle.succeed(ip);
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sessions.create(username)}; Max-Age=${SESSION_TTL_MS / 1000}; ${cookieFlags(req)}`,
    );
    res.json({ username });
  });

  app.get("/admin/ui/session", (req, res) => {
    const token = sessionToken(req);
    const username = token && sessions.get(token);
    if (!username) {
      res.status(401).json({ error: { message: "Not signed in" } });
      return;
    }
    res.json({ username });
  });

  app.post("/admin/ui/logout", (req, res) => {
    const token = sessionToken(req);
    if (token) sessions.destroy(token);
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=; Max-Age=0; ${cookieFlags(req)}`,
    );
    res.status(204).end();
  });

  // Admin calls authenticate with an admin API key (scripts, ai-employee) or
  // with the dashboard's session cookie. A cookie alone can be sent by any
  // page the browser visits, so cookie calls must also carry a custom header
  // that cross-site requests cannot add without a CORS preflight.
  const adminAuth: express.RequestHandler = (req, res, next) => {
    const token = extractApiKey(req.headers) ? undefined : sessionToken(req);
    const username = token && sessions.get(token);
    if (!username) return requireApiKey(req, res, next);
    if (req.headers["x-relay-csrf"] !== "1") {
      res
        .status(403)
        .json({ error: { message: "Missing x-relay-csrf header" } });
      return;
    }
    const secret = `session:${username}`;
    res.locals.keyEntry = {
      name: username,
      key: secret,
      models: ["*"],
      admin: true,
    };
    seedStats(req, res, secret);
    next();
  };

  app.use("/admin", adminAuth);
  app.use("/admin", statsFinishMiddleware);
  app.use("/admin", requireAdmin);
  registerKeyRoutes(app, keyStore, statsRecorder, catalog);
  registerGoAdminRoutes(app, config, goPool, catalog);

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

  // What the setup scripts write into OpenCode for this key: one tab-separated
  // line per model, "<id>\t<allowed|on_request>\t<display name>". Models the key
  // can use now come first-class; "on request" models are listed too, labelled,
  // so a temporary grant works without anyone re-running setup.
  app.get("/setup/models", requireApiKey, (_req, res) => {
    const entry = res.locals.keyEntry as ApiKeyEntry;
    const listed = new Set<string>();
    const lines: string[] = [];
    for (const m of catalog.list()) {
      listed.add(resolveModel(m.id));
      if (keyStore.allows(entry, m.id)) {
        lines.push(`${m.id}\tallowed\t${m.name}`);
      } else if (m.access === "on_request") {
        lines.push(`${m.id}\ton_request\t${m.name} (on request)`);
      }
    }
    for (const id of keyStore.allowedIds(entry)) {
      if (!listed.has(resolveModel(id))) lines.push(`${id}\tallowed\t${id}`);
    }
    res
      .set("Cache-Control", "no-store")
      .type("text/plain; charset=utf-8")
      .send(lines.length ? `${lines.join("\n")}\n` : "");
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
        const ended = keyStore.endedGrantFor(entry, model);
        res.status(403).json({
          error: {
            message: ended
              ? `Your temporary access to "${model}" ended ${agoText(keyStore.now() - Date.parse(ended.until))}. Ask the engineering team for more time.`
              : `"${model}" is not enabled for this key. Ask the engineering team for access.`,
            type: "model_not_allowed",
            ...(ended && { code: "grant_expired" }),
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
  // OpenCode Go models (go/<id>) go straight to Go with a key from the pool.
  // This sits after the per-key policy above, so the model allowlist, grants and
  // daily token cap apply to them exactly as to every other model.
  const goRoutes: Array<[string, "chat" | "responses" | "messages" | "count"]> =
    [
      ["/v1/chat/completions", "chat"],
      ["/v1/responses", "responses"],
      ["/v1/messages", "messages"],
      ["/v1/messages/count_tokens", "count"],
    ];
  for (const [route, kind] of goRoutes) {
    const handler = createGoHandler(config, goPool, kind);
    app.post(route, (req, res, next) =>
      isGoModel(req.body?.model) ? handler(req, res, next) : next(),
    );
  }

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
    const reported = new Set(data.map((m) => resolveModel(m.id)));
    for (const m of catalog.list()) {
      if (reported.has(resolveModel(m.id)) || !keyStore.allows(entry, m.id))
        continue;
      data.push({ id: m.id, object: "model", created, owned_by: "relay" });
    }
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
