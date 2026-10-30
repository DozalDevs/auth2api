import express from "express";
import { AccessRequest, ApiKeyEntry, Member } from "../config";
import {
  LoginThrottle,
  SESSION_TTL_MS,
  SessionStore,
} from "../auth/dashboard-login";
import { AccessRequestStore, describeRequest } from "../keys/requests";
import { KeyStore, KeyStoreError } from "../keys/store";
import { ModelCatalog } from "../models/catalog";
import { StatsRecorder } from "../stats/recorder";
import { hashApiKey } from "../utils/common";
import { clientIp } from "../utils/rate-limit";
import { resolveModel } from "../upstream/translator";
import { MemberStore } from "./store";

export const MEMBER_COOKIE = "relay_member";
const COOKIE_PATH = "/account";
const USAGE_DAYS = 7;

export function originOf(req: express.Request): string {
  const proto =
    String(req.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim() || req.protocol;
  return `${proto}://${req.get("host")}`;
}

function handle(fn: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch((err) => {
        if (err instanceof KeyStoreError) {
          res.status(err.status).json({ error: { message: err.message } });
          return;
        }
        next(err);
      });
  };
}

export interface MemberAdminDeps {
  keys: KeyStore;
  members: MemberStore;
  publicUrl?: string;
}

export function registerMemberAdminRoutes(
  app: express.Application,
  deps: MemberAdminDeps,
): void {
  const who = (res: express.Response): string =>
    (res.locals.keyEntry as ApiKeyEntry | undefined)?.name ?? "an admin";

  app.post(
    "/admin/keys/:name/invite",
    handle((req, res) => {
      const { token, invite } = deps.members.invite(
        req.params.name,
        req.body?.email,
        who(res),
      );
      const base = deps.publicUrl ?? originOf(req);
      res.status(201).json({
        key: invite.key,
        email: invite.email,
        expires_at: invite["expires-at"],
        link: `${base}/account#invite=${token}`,
      });
    }),
  );

  app.delete(
    "/admin/keys/:name/login",
    handle((req, res) => {
      const entry = deps.keys.get(req.params.name);
      if (!entry)
        throw new KeyStoreError(404, `no key named "${req.params.name}"`);
      if (!deps.members.removeForKey(entry.name)) {
        throw new KeyStoreError(404, `${entry.name} has no sign-in`);
      }
      res.status(204).end();
    }),
  );
}

export interface AccountDeps {
  keys: KeyStore;
  catalog: ModelCatalog;
  requests: AccessRequestStore;
  members: MemberStore;
  stats?: StatsRecorder;
  sessions: SessionStore;
  loginThrottle: LoginThrottle;
  rateLimit: express.RequestHandler;
  onRequestCreated?: (created: AccessRequest) => void;
}

function cookieFlags(req: express.Request): string {
  const secure =
    req.secure || req.headers["x-forwarded-proto"] === "https"
      ? "; Secure"
      : "";
  return `HttpOnly; SameSite=Strict; Path=${COOKIE_PATH}${secure}`;
}

function sessionToken(req: express.Request): string | undefined {
  return new RegExp(`(?:^|;\\s*)${MEMBER_COOKIE}=([a-f0-9]{64})`).exec(
    req.headers.cookie || "",
  )?.[1];
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The teammate's own page API. Everything is scoped to the key the sign-in is
 * linked to: that key comes from the session, never from the browser. It uses
 * its own cookie, path and session store, so an admin session can never act as
 * a teammate and a teammate session can never reach /admin.
 */
export function registerAccountRoutes(
  app: express.Application,
  deps: AccountDeps,
): void {
  const startSession = (
    req: express.Request,
    res: express.Response,
    m: Member,
  ) => {
    res.setHeader(
      "Set-Cookie",
      `${MEMBER_COOKIE}=${deps.sessions.create(m.email)}; Max-Age=${SESSION_TTL_MS / 1000}; ${cookieFlags(req)}`,
    );
  };

  const csrf: express.RequestHandler = (req, res, next) => {
    if (req.method !== "GET" && req.headers["x-relay-csrf"] !== "1") {
      res
        .status(403)
        .json({ error: { message: "Missing x-relay-csrf header" } });
      return;
    }
    next();
  };

  app.use("/account/api", deps.rateLimit, csrf);

  app.post(
    "/account/api/login",
    handle(async (req, res) => {
      const ip = clientIp(req);
      if (deps.loginThrottle.blocked(ip)) {
        res.status(429).json({
          error: {
            message: "Too many failed attempts. Try again in a few minutes.",
          },
        });
        return;
      }
      const member = await deps.members.login(
        req.body?.email,
        req.body?.password,
      );
      if (!member) {
        deps.loginThrottle.fail(ip);
        res
          .status(401)
          .json({ error: { message: "Wrong email or password." } });
        return;
      }
      deps.loginThrottle.succeed(ip);
      startSession(req, res, member);
      res.json({ email: member.email });
    }),
  );

  app.post(
    "/account/api/accept",
    handle(async (req, res) => {
      const ip = clientIp(req);
      if (deps.loginThrottle.blocked(ip)) {
        res.status(429).json({
          error: {
            message: "Too many failed attempts. Try again in a few minutes.",
          },
        });
        return;
      }
      try {
        const member = await deps.members.accept(
          req.body?.token,
          req.body?.password,
        );
        deps.loginThrottle.succeed(ip);
        startSession(req, res, member);
        res.status(201).json({ email: member.email });
      } catch (err) {
        if (err instanceof KeyStoreError && err.status < 500)
          deps.loginThrottle.fail(ip);
        throw err;
      }
    }),
  );

  app.post("/account/api/logout", (req, res) => {
    const token = sessionToken(req);
    if (token) deps.sessions.destroy(token);
    res.setHeader(
      "Set-Cookie",
      `${MEMBER_COOKIE}=; Max-Age=0; ${cookieFlags(req)}`,
    );
    res.status(204).end();
  });

  const signedIn: express.RequestHandler = (req, res, next) => {
    const token = sessionToken(req);
    const email = token && deps.sessions.get(token);
    const member = email ? deps.members.byEmail(email) : undefined;
    if (!member) {
      res.status(401).json({ error: { message: "Not signed in" } });
      return;
    }
    const entry = deps.keys.get(member.key);
    if (!entry) {
      res.status(403).json({
        error: {
          message:
            "This sign-in has no key behind it. Ask the engineering team.",
        },
      });
      return;
    }
    res.locals.member = member;
    res.locals.entry = entry;
    next();
  };

  const me = (res: express.Response) => ({
    member: res.locals.member as Member,
    entry: res.locals.entry as ApiKeyEntry,
  });

  app.get("/account/api/session", signedIn, (_req, res) => {
    res.json({ email: me(res).member.email });
  });

  app.get(
    "/account/api/me",
    signedIn,
    handle((_req, res) => {
      const { member, entry } = me(res);
      const at = deps.keys.now();
      const pending = new Map<string, string>();
      for (const r of deps.requests.list({
        key: entry.name,
        status: "pending",
      })) {
        for (const m of r.models) pending.set(resolveModel(m), r.id);
      }
      const listed = new Set<string>();
      const models = deps.catalog.list().map((m) => {
        listed.add(resolveModel(m.id));
        const allowed = deps.keys.allows(entry, m.id, at);
        const loan = deps.keys.loanFor(entry, m.id, at);
        return {
          id: m.id,
          name: m.name,
          access: m.access,
          state: allowed ? "allowed" : "ask",
          loan: loan
            ? {
                until: loan.until,
                seconds_left: Math.max(
                  0,
                  Math.round((Date.parse(loan.until) - at) / 1000),
                ),
              }
            : null,
          pending_request: allowed
            ? null
            : (pending.get(resolveModel(m.id)) ?? null),
        };
      });
      for (const id of deps.keys.allowedIds(entry, at)) {
        if (listed.has(resolveModel(id))) continue;
        models.push({
          id,
          name: id,
          access: "standard",
          state: "allowed",
          loan: null,
          pending_request: null,
        });
      }

      const limit = entry["daily-token-limit"] ?? null;
      let usage: {
        days: Array<{ day: string; tokens: number; requests: number }>;
      } | null = null;
      let tokensToday: number | null = null;
      if (deps.stats) {
        const hash = hashApiKey(entry.key);
        const since = utcDay(at - (USAGE_DAYS - 1) * 86_400_000);
        const byDay = new Map<
          string,
          { day: string; tokens: number; requests: number }
        >();
        for (const r of deps.stats.usageRows(since)) {
          if (r.apiKeyHash !== hash) continue;
          const d = byDay.get(r.day) ?? { day: r.day, tokens: 0, requests: 0 };
          d.tokens += r.inputTokens + r.outputTokens;
          d.requests += r.requests;
          byDay.set(r.day, d);
        }
        usage = {
          days: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
        };
        tokensToday = deps.stats.tokensOnDay(hash, utcDay(at));
      }

      res.json({
        email: member.email,
        key: {
          name: entry.name,
          suffix: entry.key.slice(-4),
          disabled: entry.disabled === true,
        },
        models,
        daily_token_limit: limit,
        tokens_today: tokensToday,
        usage,
        requests: deps.requests
          .list({ key: entry.name })
          .slice(0, 20)
          .map((r) => describeRequest(r, at)),
      });
    }),
  );

  app.post(
    "/account/api/requests",
    signedIn,
    handle((req, res) => {
      const { entry } = me(res);
      if (entry.disabled) {
        throw new KeyStoreError(
          403,
          "Your key is switched off. Ask the engineering team.",
        );
      }
      const b = req.body ?? {};
      const minutes =
        b.minutes !== undefined
          ? b.minutes
          : typeof b.hours === "number"
            ? Math.round(b.hours * 60)
            : undefined;
      const created = deps.requests.create(entry, {
        models: b.models ?? b.model,
        reason: b.reason,
        minutes,
      });
      deps.onRequestCreated?.(created);
      res.status(201).json(describeRequest(created, deps.keys.now()));
    }),
  );

  app.delete(
    "/account/api/requests/:id",
    signedIn,
    handle((req, res) => {
      const { entry } = me(res);
      res.json(
        describeRequest(
          deps.requests.cancel(req.params.id, entry.name),
          deps.keys.now(),
        ),
      );
    }),
  );
}
