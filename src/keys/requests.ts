import crypto from "crypto";
import express from "express";
import { AccessRequest, ApiKeyEntry, isValidModelId } from "../config";
import { ModelCatalog } from "../models/catalog";
import { resolveModel } from "../upstream/translator";
import {
  KeyStore,
  KeyStoreError,
  MAX_GRANT_MINUTES,
  MIN_GRANT_MINUTES,
} from "./store";

export const DEFAULT_REQUEST_MINUTES = 4 * 60;
export const MAX_REASON_LENGTH = 500;
export const MAX_NOTE_LENGTH = 200;
export const MAX_MODELS_PER_REQUEST = 5;
export const MAX_PENDING_PER_KEY = 10;
/** How long a decided request stays on the list. */
export const DECIDED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export interface RequestInput {
  models: unknown;
  reason: unknown;
  minutes?: unknown;
}

function text(v: unknown, field: string, max: number, required: boolean) {
  if (v === undefined || v === null || v === "") {
    if (required) {
      throw new KeyStoreError(
        400,
        `${field} is required: say in a sentence why you need it`,
      );
    }
    return undefined;
  }
  if (typeof v !== "string" || v.length > max) {
    throw new KeyStoreError(
      400,
      `${field} must be text of at most ${max} characters`,
    );
  }
  const t = v.trim();
  if (!t && required) {
    throw new KeyStoreError(
      400,
      `${field} is required: say in a sentence why you need it`,
    );
  }
  return t || undefined;
}

function minutesFrom(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (
    typeof v !== "number" ||
    !Number.isInteger(v) ||
    v < MIN_GRANT_MINUTES ||
    v > MAX_GRANT_MINUTES
  ) {
    throw new KeyStoreError(
      400,
      `duration must be a whole number of minutes from ${MIN_GRANT_MINUTES} to ${MAX_GRANT_MINUTES} (7 days)`,
    );
  }
  return v;
}

/**
 * Requests for temporary model access. A key holder asks with a reason; an
 * admin approves (which creates an ordinary grant, so everything that already
 * applies to grants applies here) or rejects.
 */
export class AccessRequestStore {
  private items: AccessRequest[];

  constructor(
    initial: AccessRequest[],
    private readonly keys: KeyStore,
    private readonly catalog: ModelCatalog,
    private readonly opts: {
      persist?: (requests: AccessRequest[]) => void;
    } = {},
  ) {
    this.items = initial.map((r) => ({ ...r, models: [...r.models] }));
  }

  list(filter: { key?: string; status?: string } = {}): AccessRequest[] {
    return this.items
      .filter(
        (r) => !filter.key || r.key.toLowerCase() === filter.key.toLowerCase(),
      )
      .filter(
        (r) =>
          !filter.status ||
          filter.status === "all" ||
          r.status === filter.status,
      )
      .sort(
        (a, b) => Date.parse(b["requested-at"]) - Date.parse(a["requested-at"]),
      )
      .map((r) => ({ ...r, models: [...r.models] }));
  }

  pendingCount(): number {
    return this.items.filter((r) => r.status === "pending").length;
  }

  create(entry: ApiKeyEntry, input: RequestInput): AccessRequest {
    const raw = Array.isArray(input.models) ? input.models : [input.models];
    if (
      raw.length === 0 ||
      raw.length > MAX_MODELS_PER_REQUEST ||
      !raw.every(isValidModelId)
    ) {
      throw new KeyStoreError(
        400,
        `models must be 1 to ${MAX_MODELS_PER_REQUEST} model names from the model list`,
      );
    }
    const reason = text(input.reason, "reason", MAX_REASON_LENGTH, true)!;
    const minutes = minutesFrom(input.minutes, DEFAULT_REQUEST_MINUTES);

    const known = new Map(
      this.catalog.list().map((m) => [resolveModel(m.id), m.id]),
    );
    const models: string[] = [];
    for (const m of raw as string[]) {
      const id = known.get(resolveModel(m));
      if (!id) {
        throw new KeyStoreError(
          400,
          `"${m}" is not a model on the list. See GET /setup/models for the models you can ask for.`,
        );
      }
      if (this.keys.allows(entry, id)) {
        throw new KeyStoreError(409, `you can already use "${id}"`);
      }
      if (!models.includes(id)) models.push(id);
    }

    const mine = this.items.filter(
      (r) =>
        r.status === "pending" &&
        r.key.toLowerCase() === entry.name.toLowerCase(),
    );
    const dup = models.find((m) => mine.some((r) => r.models.includes(m)));
    if (dup) {
      throw new KeyStoreError(
        409,
        `you already have a pending request for "${dup}"; wait for an answer or cancel it first`,
      );
    }
    if (mine.length >= MAX_PENDING_PER_KEY) {
      throw new KeyStoreError(
        429,
        `you already have ${MAX_PENDING_PER_KEY} pending requests; wait for answers first`,
      );
    }

    const request: AccessRequest = {
      id: crypto.randomBytes(4).toString("hex"),
      key: entry.name,
      models,
      reason,
      minutes,
      status: "pending",
      "requested-at": new Date(this.keys.now()).toISOString(),
    };
    this.commit([...this.items, request]);
    console.log(
      `[request] "${entry.name}" asked for ${models.join(", ")} for ${minutes} min: ${reason}`,
    );
    return { ...request, models: [...request.models] };
  }

  private pending(id: string): AccessRequest {
    const r = this.items.find((x) => x.id === id);
    if (!r) throw new KeyStoreError(404, `no request "${id}"`);
    if (r.status !== "pending") {
      throw new KeyStoreError(
        409,
        `request "${id}" was already ${r.status}${r["decided-by"] ? ` by ${r["decided-by"]}` : ""}`,
      );
    }
    return r;
  }

  approve(
    id: string,
    by: string,
    input: { minutes?: unknown; note?: unknown } = {},
  ): AccessRequest {
    const r = this.pending(id);
    const minutes = minutesFrom(input.minutes, r.minutes);
    const note = text(input.note, "note", MAX_NOTE_LENGTH, false);
    const { grant } = this.keys.grant(
      r.key,
      {
        models: r.models,
        minutes,
        note:
          r.reason.length > MAX_NOTE_LENGTH
            ? `${r.reason.slice(0, MAX_NOTE_LENGTH - 1)}\u2026`
            : r.reason,
      },
      by,
    );
    const done: AccessRequest = {
      ...r,
      minutes,
      status: "approved",
      "decided-at": new Date(this.keys.now()).toISOString(),
      "decided-by": by,
      until: grant.until,
    };
    if (note) done["decision-note"] = note;
    this.commit(this.items.map((x) => (x === r ? done : x)));
    return { ...done, models: [...done.models] };
  }

  reject(
    id: string,
    by: string,
    input: { note?: unknown } = {},
  ): AccessRequest {
    const r = this.pending(id);
    const note = text(input.note, "note", MAX_NOTE_LENGTH, false);
    const done: AccessRequest = {
      ...r,
      status: "rejected",
      "decided-at": new Date(this.keys.now()).toISOString(),
      "decided-by": by,
    };
    if (note) done["decision-note"] = note;
    this.commit(this.items.map((x) => (x === r ? done : x)));
    console.log(
      `[request] ${by} rejected ${r.key}'s request for ${r.models.join(", ")}`,
    );
    return { ...done, models: [...done.models] };
  }

  /** The person who asked withdraws a request that is still waiting. */
  cancel(id: string, keyName: string): AccessRequest {
    const r = this.items.find((x) => x.id === id);
    if (!r || r.key.toLowerCase() !== keyName.toLowerCase()) {
      throw new KeyStoreError(404, `no request "${id}"`);
    }
    this.pending(id);
    const done: AccessRequest = {
      ...r,
      status: "cancelled",
      "decided-at": new Date(this.keys.now()).toISOString(),
      "decided-by": keyName,
    };
    this.commit(this.items.map((x) => (x === r ? done : x)));
    return { ...done, models: [...done.models] };
  }

  private commit(proposed: AccessRequest[]): void {
    const at = this.keys.now();
    const next = proposed.filter(
      (r) =>
        r.status === "pending" ||
        at - Date.parse(r["decided-at"] ?? r["requested-at"]) <=
          DECIDED_KEEP_MS,
    );
    try {
      this.opts.persist?.(next);
    } catch (err: any) {
      throw new KeyStoreError(500, `could not save config: ${err.message}`);
    }
    this.items = next;
  }
}

function describe(r: AccessRequest, at: number) {
  return {
    id: r.id,
    key: r.key,
    models: r.models,
    reason: r.reason,
    requested_minutes: r.minutes,
    status: r.status,
    requested_at: r["requested-at"],
    decided_at: r["decided-at"] ?? null,
    decided_by: r["decided-by"] ?? null,
    decision_note: r["decision-note"] ?? null,
    ...(r.status === "approved" && r.until
      ? {
          until: r.until,
          seconds_left: Math.max(
            0,
            Math.round((Date.parse(r.until) - at) / 1000),
          ),
        }
      : {}),
  };
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

/**
 * What a key holder can do for themselves: ask, look at their own requests,
 * withdraw one that is still waiting. Mounted behind the normal key check.
 */
export function registerRequestRoutes(
  app: express.Application,
  requests: AccessRequestStore,
  keys: KeyStore,
  guard: express.RequestHandler[],
): void {
  const me = (res: express.Response) => res.locals.keyEntry as ApiKeyEntry;

  app.post(
    "/access-requests",
    ...guard,
    handle((req, res) => {
      const b = req.body ?? {};
      const minutes =
        b.minutes !== undefined
          ? b.minutes
          : typeof b.hours === "number"
            ? Math.round(b.hours * 60)
            : undefined;
      const created = requests.create(me(res), {
        models: b.models ?? b.model,
        reason: b.reason,
        minutes,
      });
      res.status(201).json(describe(created, keys.now()));
    }),
  );

  app.get(
    "/access-requests",
    ...guard,
    handle((_req, res) => {
      res.json({
        requests: requests
          .list({ key: me(res).name })
          .map((r) => describe(r, keys.now())),
      });
    }),
  );

  app.delete(
    "/access-requests/:id",
    ...guard,
    handle((req, res) => {
      res.json(
        describe(requests.cancel(req.params.id, me(res).name), keys.now()),
      );
    }),
  );
}

/** What an approver can do. Mounted behind the admin check. */
export function registerRequestAdminRoutes(
  app: express.Application,
  requests: AccessRequestStore,
  keys: KeyStore,
): void {
  const who = (res: express.Response): string =>
    (res.locals.keyEntry as ApiKeyEntry | undefined)?.name ?? "an admin";

  app.get(
    "/admin/access-requests",
    handle((req, res) => {
      const status =
        typeof req.query.status === "string" ? req.query.status : "pending";
      res.json({
        pending: requests.pendingCount(),
        requests: requests.list({ status }).map((r) => describe(r, keys.now())),
      });
    }),
  );

  app.post(
    "/admin/access-requests/:id/approve",
    handle((req, res) => {
      const b = req.body ?? {};
      const minutes =
        b.minutes !== undefined
          ? b.minutes
          : typeof b.hours === "number"
            ? Math.round(b.hours * 60)
            : undefined;
      res.json(
        describe(
          requests.approve(req.params.id, who(res), { minutes, note: b.note }),
          keys.now(),
        ),
      );
    }),
  );

  app.post(
    "/admin/access-requests/:id/reject",
    handle((req, res) => {
      res.json(
        describe(
          requests.reject(req.params.id, who(res), { note: req.body?.note }),
          keys.now(),
        ),
      );
    }),
  );
}
