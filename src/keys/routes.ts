import express from "express";
import { ApiKeyEntry, KeyGrant, STANDARD_GROUP } from "../config";
import { ModelCatalog } from "../models/catalog";
import { StatsRecorder } from "../stats/recorder";
import { hashApiKey } from "../utils/common";
import { MemberStore } from "../members/store";
import { KeyPatch, KeyStore, KeyStoreError } from "./store";

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function describeGrant(grant: KeyGrant, at: number, ended: boolean) {
  const until = Date.parse(grant.until);
  return {
    id: grant.id,
    models: grant.models,
    until: grant.until,
    granted_at: grant["granted-at"],
    note: grant.note ?? null,
    ...(ended
      ? { ended_seconds_ago: Math.max(0, Math.round((at - until) / 1000)) }
      : { seconds_left: Math.max(0, Math.round((until - at) / 1000)) }),
  };
}

function describe(
  entry: ApiKeyEntry,
  store: KeyStore,
  stats?: StatsRecorder,
  members?: MemberStore,
) {
  const at = store.now();
  const limit = entry["daily-token-limit"] ?? null;
  const used = stats
    ? stats.tokensOnDay(hashApiKey(entry.key), utcDay())
    : null;
  return {
    name: entry.name,
    models: entry.models,
    grants: store
      .activeGrants(entry, at)
      .map((g) => describeGrant(g, at, false)),
    ended_grants: store
      .endedGrants(entry, at)
      .map((g) => describeGrant(g, at, true)),
    daily_token_limit: limit,
    disabled: entry.disabled === true,
    admin: entry.admin === true,
    key_suffix: entry.key.slice(-4),
    login: members?.forKey(entry.name)?.email ?? null,
    invite: members?.pendingInvite(entry.name)
      ? {
          email: members.pendingInvite(entry.name)!.email,
          expires_at: members.pendingInvite(entry.name)!["expires-at"],
        }
      : null,
    tokens_today: used,
    tokens_remaining_today:
      limit !== null && used !== null ? Math.max(0, limit - used) : null,
  };
}

function patchFromBody(body: any): KeyPatch {
  const patch: KeyPatch = {};
  if (body.models !== undefined) patch.models = body.models;
  if (body.daily_token_limit !== undefined) {
    patch["daily-token-limit"] = body.daily_token_limit;
  }
  if (body.disabled !== undefined) patch.disabled = body.disabled;
  return patch;
}

function handle(fn: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    try {
      fn(req, res, next);
    } catch (err) {
      if (err instanceof KeyStoreError) {
        res.status(err.status).json({ error: { message: err.message } });
        return;
      }
      next(err);
    }
  };
}

function grantMinutes(body: any): number {
  if (body.minutes !== undefined) return body.minutes;
  if (typeof body.hours === "number") return Math.round(body.hours * 60);
  return NaN;
}

export function registerKeyRoutes(
  app: express.Application,
  store: KeyStore,
  stats?: StatsRecorder,
  catalog?: ModelCatalog,
  members?: MemberStore,
): void {
  const actor = (res: express.Response): string =>
    (res.locals.keyEntry as ApiKeyEntry | undefined)?.name ?? "an admin";

  app.get(
    "/admin/keys",
    handle((_req, res) => {
      res.json({
        keys: store.list().map((e) => describe(e, store, stats, members)),
      });
    }),
  );

  app.post(
    "/admin/keys",
    handle((req, res) => {
      const b = req.body ?? {};
      const entry = store.create({
        name: b.name,
        models: b.models === undefined ? [STANDARD_GROUP] : b.models,
        ...(b.daily_token_limit !== undefined && {
          "daily-token-limit": b.daily_token_limit,
        }),
        ...(b.admin !== undefined && { admin: b.admin }),
      });
      res
        .status(201)
        .json({ ...describe(entry, store, stats, members), key: entry.key });
    }),
  );

  app.patch(
    "/admin/keys/:name",
    handle((req, res) => {
      const entry = store.update(
        req.params.name,
        patchFromBody(req.body ?? {}),
      );
      res.json(describe(entry, store, stats, members));
    }),
  );

  app.post(
    "/admin/keys/:name/grants",
    handle((req, res) => {
      const b = req.body ?? {};
      const { entry, grant } = store.grant(
        req.params.name,
        { models: b.models, minutes: grantMinutes(b), note: b.note },
        actor(res),
      );
      res.status(201).json({
        ...describe(entry, store, stats, members),
        grant: describeGrant(grant, store.now(), false),
      });
    }),
  );

  app.delete(
    "/admin/keys/:name/grants/:id",
    handle((req, res) => {
      const entry = store.revokeGrant(
        req.params.name,
        req.params.id,
        actor(res),
      );
      res.json(describe(entry, store, stats, members));
    }),
  );

  app.delete(
    "/admin/keys/:name",
    handle((req, res) => {
      store.remove(req.params.name);
      members?.removeForKey(req.params.name);
      res.status(204).end();
    }),
  );

  if (catalog) {
    app.get(
      "/admin/models",
      handle((_req, res) => {
        res.json({ models: catalog.list(), source: catalog.source() });
      }),
    );

    app.post(
      "/admin/models",
      handle((req, res) => {
        res.status(201).json(catalog.upsert(req.body ?? {}));
      }),
    );

    app.delete(
      "/admin/models/:id",
      handle((req, res) => {
        catalog.remove(req.params.id);
        res.status(204).end();
      }),
    );
  }

  app.get(
    "/admin/usage",
    handle((req, res) => {
      if (!stats) {
        res.status(409).json({ error: { message: "stats are disabled" } });
        return;
      }
      const days = Math.min(Math.max(Number(req.query.days) || 1, 1), 366);
      const since = utcDay(new Date(Date.now() - (days - 1) * 86_400_000));
      const nameByHash = new Map(
        store.list().map((e) => [hashApiKey(e.key), e.name]),
      );
      const rows = stats
        .usageRows(since)
        .map(({ apiKeyHash, ...r }) => ({
          name:
            nameByHash.get(apiKeyHash) ?? `unknown:${apiKeyHash.slice(0, 12)}`,
          ...r,
        }))
        .sort(
          (a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name),
        );
      const byKey = new Map<string, { requests: number; tokens: number }>();
      for (const r of rows) {
        const cur = byKey.get(r.name) ?? { requests: 0, tokens: 0 };
        cur.requests += r.requests;
        cur.tokens += r.inputTokens + r.outputTokens;
        byKey.set(r.name, cur);
      }
      res.json({
        since,
        days,
        by_key: Array.from(byKey, ([name, v]) => ({ name, ...v })),
        rows,
      });
    }),
  );
}
