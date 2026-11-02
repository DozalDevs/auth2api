import express from "express";
import { CatalogModel, Config } from "../config";
import { GoKeyPool } from "../opencode-go/pool";
import { isGoModel } from "../opencode-go/proxy";
import { ModelCatalog } from "../models/catalog";
import { KeyStore } from "../keys/store";
import { ProviderRegistry } from "../providers/registry";
import { KeyStoreError } from "../keys/store";
import { ImageOutcome, imageViaCodex, imageViaGo, OneImage } from "./upstream";
import { parseImageRequest } from "./request";
import { UsageData } from "../accounts/manager";

function handle(
  fn: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((err) => {
      if (err instanceof KeyStoreError) {
        res.status(err.status).json({
          error: { message: err.message, type: "invalid_request_error" },
        });
        return;
      }
      next(err);
    });
  };
}

export function imageModels(catalog: ModelCatalog): CatalogModel[] {
  return catalog.list().filter((m) => m.kind === "image");
}

/**
 * Fills in the model when a caller leaves it out, before the per-key checks
 * run, so a key that may not use images gets the normal "ask for it" answer
 * instead of a confusing "model is required".
 */
export function defaultImageModel(
  catalog: ModelCatalog,
): express.RequestHandler {
  return (req, _res, next) => {
    if (
      req.method === "POST" &&
      req.body &&
      typeof req.body === "object" &&
      !Array.isArray(req.body) &&
      !(typeof req.body.model === "string" && req.body.model.trim())
    ) {
      const first = imageModels(catalog)[0];
      if (first) {
        req.body.model = first.id;
        _res.locals.imageModelDefaulted = true;
      }
    }
    next();
  };
}

export interface ImageRouteDeps {
  config: Config;
  registry: ProviderRegistry;
  catalog: ModelCatalog;
  goPool: GoKeyPool;
  keys: KeyStore;
}

/** Failures that mean "this service cannot serve you right now", as opposed to "your request is wrong". */
const FALL_BACK_ON = new Set([429, 500, 502, 503, 504]);

function sum(a: UsageData, b: UsageData): UsageData {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens:
      a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

export function registerImageRoutes(
  app: express.Application,
  deps: ImageRouteDeps,
): void {
  const serve =
    (kind: "generate" | "edit") =>
    async (req: express.Request, res: express.Response) => {
      const stats = res.locals.stats as Record<string, any> | undefined;
      if (/^multipart\//i.test(String(req.headers["content-type"] ?? ""))) {
        throw new KeyStoreError(
          415,
          "send JSON, not a form upload. Edits take images as data URLs in an images list.",
        );
      }
      const parsed = parseImageRequest(kind, req.body);
      const models = imageModels(deps.catalog);
      if (models.length === 0) {
        res.status(404).json({
          error: {
            message: "No image models are set up on this relay.",
            type: "no_image_models",
          },
        });
        return;
      }
      const wanted = (parsed.model ?? models[0].id).toLowerCase();
      const model = models.find((m) => m.id.toLowerCase() === wanted);
      if (!model) {
        throw new KeyStoreError(
          400,
          `"${parsed.model}" is not an image model on this relay. Image models: ${models.map((m) => m.id).join(", ")}.`,
        );
      }
      const entry = res.locals.keyEntry;
      const candidates: CatalogModel[] = res.locals.imageModelDefaulted
        ? models.filter(
            (m) => m === model || (entry && deps.keys.allows(entry, m.id)),
          )
        : [model];
      if (stats) {
        stats.model = model.id;
        stats.provider = isGoModel(model.id) ? "opencode-go" : "codex";
      }

      const gone = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) gone.abort();
      });
      const tryModel = (m: CatalogModel): Promise<ImageOutcome> =>
        isGoModel(m.id)
          ? imageViaGo(
              {
                config: deps.config,
                pool: deps.goPool,
                http: req,
                httpRes: res,
                signal: gone.signal,
              },
              parsed,
            )
          : imageViaCodex(
              {
                provider: deps.registry.forModel("gpt-6-luna"),
                config: deps.config,
                signal: gone.signal,
              },
              parsed,
              undefined,
            );
      const one = async (): Promise<ImageOutcome> => {
        let last: ImageOutcome | undefined;
        for (const m of candidates) {
          last = await tryModel(m);
          if (last.ok) return { ...last, model: m.id };
          if (!FALL_BACK_ON.has(last.status) || gone.signal.aborted) break;
          console.log(
            `[images] ${m.id} could not serve this request (${last.status}); trying the next image model`,
          );
        }
        return last!;
      };

      const settled = await Promise.all(
        Array.from({ length: parsed.n }, () => one()),
      );
      if (gone.signal.aborted) return;
      const good = settled.filter(
        (o): o is Extract<ImageOutcome, { ok: true }> => o.ok,
      );
      if (good.length === 0) {
        const failed = settled.find(
          (o): o is Extract<ImageOutcome, { ok: false }> => !o.ok,
        )!;
        if (stats) stats.failureKind = failed.type;
        res.status(failed.status).json({
          error: { message: failed.message, type: failed.type },
        });
        return;
      }
      const usage = good.map((g) => g.usage).reduce(sum);
      if (stats) {
        stats.usage = usage;
        stats.accountEmail = good[0].account;
        stats.model = good[0].model;
        stats.provider = isGoModel(good[0].model) ? "opencode-go" : "codex";
      }
      const data: OneImage[] = good.map((g) => g.image);
      res.json({
        created: Math.floor(Date.now() / 1000),
        data,
        output_format: "png",
        ...(good[0].size && { size: good[0].size }),
        ...(good[0].quality && { quality: good[0].quality }),
        ...(good[0].background && { background: good[0].background }),
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens,
        },
        ...(good.length < parsed.n && {
          warning: `${parsed.n - good.length} of ${parsed.n} images could not be made`,
        }),
      });
    };

  app.post("/v1/images/generations", handle(serve("generate")));
  app.post("/v1/images/edits", handle(serve("edit")));
}
