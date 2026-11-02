import express from "express";
import { UsageData } from "../accounts/manager";
import { classifyFailure, RETRYABLE_STATUSES } from "../utils/http";
import { Config } from "../config";
import { Provider } from "../providers/types";
import {
  callCodexImages,
  IMAGES_EDITS_PATH,
  IMAGES_GENERATIONS_PATH,
} from "../upstream/codex-api";
import { GoKeyPool } from "../opencode-go/pool";
import { callGo, goRequestHeaders } from "../opencode-go/proxy";
import { IMAGE_TIMEOUT_MS } from "../upstream/codex-api";
import { ImageRequest } from "./request";

export interface OneImage {
  b64_json: string;
  revised_prompt?: string;
}

export type ImageOutcome =
  | {
      ok: true;
      image: OneImage;
      usage: UsageData;
      size?: string;
      quality?: string;
      background?: string;
      account: string;
      /** The image model that actually made the picture; set by the route. */
      model: string;
    }
  | { ok: false; status: number; message: string; type: string };

const noUsage = (): UsageData => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningOutputTokens: 0,
});

function upstreamMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    return (
      j?.error?.message ||
      (typeof j?.detail === "string" ? j.detail : "") ||
      "The image service refused the request"
    );
  } catch {
    return "The image service refused the request";
  }
}

export const GO_IMAGE_MODEL = "gpt-6-luna";

export interface CodexImageDeps {
  provider: Provider;
  config: Config;
  signal: AbortSignal;
}

/** One picture from the ChatGPT subscription, with the same account rotation and token refresh as the text routes. */
export async function imageViaCodex(
  deps: CodexImageDeps,
  req: ImageRequest,
  upstreamModel: string | undefined,
): Promise<ImageOutcome> {
  const { provider, config, signal } = deps;
  const manager = provider.manager;
  const body: Record<string, unknown> = {
    ...(upstreamModel && { model: upstreamModel }),
    prompt: req.prompt,
    ...req.options,
  };
  if (req.kind === "edit") {
    body.images = req.images.map((image_url) => ({ image_url }));
  }
  const path =
    req.kind === "edit" ? IMAGES_EDITS_PATH : IMAGES_GENERATIONS_PATH;
  const refreshed = new Set<string>();
  let last: ImageOutcome = {
    ok: false,
    status: 502,
    message: "The image service could not be reached. Try again in a moment.",
    type: "upstream_unreachable",
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const picked = manager.getNextAccount();
    if (!picked.account) {
      return picked.failureKind === "rate_limit"
        ? {
            ok: false,
            status: 429,
            message: "The ChatGPT account is rate limited. Try again shortly.",
            type: "rate_limited",
          }
        : {
            ok: false,
            status: 503,
            message: "ChatGPT is not available on this relay right now.",
            type: "no_account_for_provider",
          };
    }
    const account = picked.account;
    const email = account.token.email;
    manager.recordAttempt(email);
    let res: Response;
    try {
      res = await callCodexImages({ path, body, account, config, signal });
    } catch (err: any) {
      if (signal.aborted) return { ...last, status: 499, message: "cancelled" };
      manager.recordFailure(email, "network", err.message);
      continue;
    }
    if (res.ok) {
      const j: any = await res.json().catch(() => null);
      const first = j?.data?.[0];
      if (typeof first?.b64_json !== "string" || !first.b64_json) {
        return {
          ok: false,
          status: 502,
          message: "The image service answered without a picture.",
          type: "upstream_error",
        };
      }
      const usage: UsageData = {
        ...noUsage(),
        inputTokens: j.usage?.input_tokens || 0,
        outputTokens: j.usage?.output_tokens || 0,
      };
      manager.recordSuccess(email, usage);
      return {
        ok: true,
        image: {
          b64_json: first.b64_json,
          ...(typeof first.revised_prompt === "string" && {
            revised_prompt: first.revised_prompt,
          }),
        },
        usage,
        size: j.size,
        quality: j.quality,
        background: j.background,
        account: email,
        model: "",
      };
    }
    const text = await res.text().catch(() => "");
    last = {
      ok: false,
      status: res.status,
      message: upstreamMessage(text),
      type: "upstream_error",
    };
    if (res.status === 401 && !refreshed.has(email)) {
      refreshed.add(email);
      if (await manager.refreshAccount(email)) {
        attempt--;
        continue;
      }
    } else if (res.status === 403 || res.status === 429 || res.status >= 500) {
      manager.recordFailure(email, classifyFailure(res.status));
    }
    if (!RETRYABLE_STATUSES.has(res.status)) break;
  }
  return last;
}

export interface GoImageDeps {
  config: Config;
  pool: GoKeyPool;
  http: express.Request;
  httpRes: express.Response;
  signal: AbortSignal;
}

/** One picture from OpenCode Go, through its OpenAI Luna model and OpenAI's own image tool. */
export async function imageViaGo(
  deps: GoImageDeps,
  req: ImageRequest,
): Promise<ImageOutcome> {
  const { config, pool, signal } = deps;
  if (pool.size === 0) {
    return {
      ok: false,
      status: 503,
      message: "OpenCode Go is not connected on this relay.",
      type: "provider_not_connected",
    };
  }
  const tool: Record<string, unknown> = {
    type: "image_generation",
    ...req.options,
  };
  const content: unknown[] = [{ type: "input_text", text: req.prompt }];
  for (const image_url of req.images) {
    content.push({ type: "input_image", image_url });
  }
  const payload = JSON.stringify({
    model: GO_IMAGE_MODEL,
    input: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "image_generation" },
  });
  const call = await callGo({
    config,
    pool,
    upstreamModel: GO_IMAGE_MODEL,
    kind: "responses",
    payload,
    headers: goRequestHeaders(deps.http, deps.httpRes),
    signal: AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]),
    gone: signal,
  });
  if (call.kind === "aborted") {
    return { ok: false, status: 499, message: "cancelled", type: "cancelled" };
  }
  if (call.kind === "refused") {
    return {
      ok: false,
      status: call.status,
      message: upstreamMessage(call.text),
      type: "upstream_error",
    };
  }
  if (call.kind === "unreachable") {
    return {
      ok: false,
      status: 502,
      message: "Could not reach OpenCode Go. Try again in a moment.",
      type: "upstream_unreachable",
    };
  }
  const text = await call.up.text().catch(() => "");
  if (!call.up.ok) {
    return {
      ok: false,
      status: call.up.status,
      message: upstreamMessage(text),
      type: "upstream_error",
    };
  }
  let j: any = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* handled below */
  }
  const item = (j?.output ?? []).find(
    (o: any) => o?.type === "image_generation_call" && o?.result,
  );
  if (!item) {
    return {
      ok: false,
      status: 502,
      message:
        "OpenCode Go answered without a picture. The request may have been refused by its safety checks.",
      type: "upstream_error",
    };
  }
  const toolUsage = j?.tool_usage?.image_gen;
  const usage: UsageData = {
    ...noUsage(),
    inputTokens: (j.usage?.input_tokens || 0) + (toolUsage?.input_tokens || 0),
    outputTokens:
      (j.usage?.output_tokens || 0) + (toolUsage?.output_tokens || 0),
  };
  return {
    ok: true,
    image: {
      b64_json: item.result,
      ...(typeof item.revised_prompt === "string" && {
        revised_prompt: item.revised_prompt,
      }),
    },
    usage,
    size: item.size,
    quality: item.quality,
    background: item.background,
    account: pool.label(call.index),
    model: "",
  };
}
