import express from "express";
import { Config } from "../config";
import { ModelCatalog } from "../models/catalog";
import { KeyStoreError } from "../keys/store";
import { describeGoModel, SKIPPED } from "./models";
import { GoKeyPool } from "./pool";
import { GO_PREFIX, goBase } from "./proxy";

/**
 * Admin routes for the OpenCode Go connection:
 *   GET  /admin/go        which keys are loaded and what Go last said to each
 *   POST /admin/go/sync   add Go's current models to the model list
 * Both sit behind the admin check. Keys are only ever shown as a short label.
 */
export function registerGoAdminRoutes(
  app: express.Application,
  config: Config,
  pool: GoKeyPool,
  catalog: ModelCatalog,
): void {
  app.get("/admin/go", (_req, res) => {
    res.json({
      connected: pool.size > 0,
      base_url: goBase(config),
      keys: pool.describe(),
    });
  });

  app.post("/admin/go/sync", async (_req, res) => {
    try {
      if (pool.size === 0) {
        throw new KeyStoreError(
          409,
          "OpenCode Go is not connected on this relay",
        );
      }
      let live: string[] | null = null;
      for (let i = 0; i < pool.size && !live; i++) {
        try {
          const r = await fetch(`${goBase(config)}/v1/models`, {
            headers: {
              authorization: `Bearer ${pool.key(i)}`,
              "user-agent": "dozaldevs-relay/1.0",
            },
            signal: AbortSignal.timeout(20_000),
          });
          pool.note(i, r.status);
          if (!r.ok) continue;
          const body = (await r.json()) as { data?: Array<{ id?: unknown }> };
          live = (body.data ?? [])
            .map((m) => m.id)
            .filter((id): id is string => typeof id === "string");
        } catch {
          pool.note(i, 0);
        }
      }
      if (!live) {
        throw new KeyStoreError(
          502,
          "OpenCode Go did not return its model list with any key",
        );
      }
      const skipped = live.filter((id) => SKIPPED[id]);
      const offered = live.filter((id) => !SKIPPED[id]).map(describeGoModel);
      const added = catalog.addMissing(offered);
      const addedIds = new Set(added.map((m) => m.id));
      res.json({
        live: live.length,
        added,
        already_listed: offered
          .filter((m) => !addedIds.has(m.id))
          .map((m) => m.id.slice(GO_PREFIX.length)),
        skipped: skipped.map((id) => ({ id, reason: SKIPPED[id] })),
      });
    } catch (err) {
      if (err instanceof KeyStoreError) {
        res.status(err.status).json({ error: { message: err.message } });
        return;
      }
      res.status(500).json({ error: { message: "sync failed" } });
    }
  });
}
