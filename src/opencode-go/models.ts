import { CatalogModel, ModelAccess } from "../config";
import { GO_PREFIX } from "./proxy";

/**
 * How each OpenCode Go model is filed in the model list. The rule is the output
 * price on Go's published table: up to $2 per million tokens is "standard"
 * (everyone on the Standard group gets it), above that is "on request" (needs a
 * temporary grant). A model not in this table is filed "on request", so a model
 * Go adds later never becomes available to everyone by accident.
 */
const KNOWN: Record<string, { name: string; access: ModelAccess }> = {
  "glm-5.3-flash": { name: "GLM-5.3 Flash", access: "standard" },
  "glm-5.3": { name: "GLM-5.3", access: "on_request" },
  "glm-5.2": { name: "GLM-5.2", access: "on_request" },
  "kimi-k3.1-pro": { name: "Kimi K3.1 Pro", access: "on_request" },
  "kimi-k3": { name: "Kimi K3", access: "on_request" },
  "kimi-k2.7-code": { name: "Kimi K2.7 Code", access: "on_request" },
  "longcat-2.0": { name: "LongCat 2.0", access: "standard" },
  "step-5-preview": { name: "Step 5 Preview", access: "on_request" },
  "beam-free": { name: "Beam Free", access: "standard" },
  "mimo-v2.6-flash": { name: "MiMo V2.6 Flash", access: "standard" },
  "mimo-v2.6-pro": { name: "MiMo V2.6 Pro", access: "standard" },
  "mimo-v2.5": { name: "MiMo V2.5", access: "standard" },
  "mimo-v2.5-pro": { name: "MiMo V2.5 Pro", access: "standard" },
  "minimax-m3.1-flash": { name: "MiniMax M3.1 Flash", access: "standard" },
  "minimax-m3": { name: "MiniMax M3", access: "standard" },
  "qwen3.8-max": { name: "Qwen3.8 Max", access: "on_request" },
  "qwen3.8-flash": { name: "Qwen3.8 Flash", access: "standard" },
  "qwen3.7-plus": { name: "Qwen3.7 Plus", access: "standard" },
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", access: "standard" },
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", access: "on_request" },
  "hy4-preview": { name: "Hy4 Preview", access: "on_request" },
  hy3: { name: "Hy3", access: "standard" },
  "grok-4.7": { name: "Grok 4.7", access: "on_request" },
  "gpt-6-luna": { name: "GPT-6 Luna", access: "standard" },
  "gpt-5.6-luna": { name: "GPT-5.6 Luna", access: "standard" },
  "claude-haiku-5-5": { name: "Claude Haiku 5.5", access: "standard" },
  "gemini-4-argon": { name: "Gemini 4 Argon", access: "on_request" },
};

/** Models the relay never offers: Go says it trains on what you send them. */
export const SKIPPED: Record<string, string> = {
  "muse-spark-1.3-contributor": "Go uses requests to this model for training",
  "muse-spark-1.2-contributor": "Go uses requests to this model for training",
  "iceman-contributor-free": "Go uses requests to this model for training",
};

function prettify(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function describeGoModel(id: string): CatalogModel {
  const known = KNOWN[id];
  return {
    id: `${GO_PREFIX}${id}`,
    name: `${known?.name ?? prettify(id)} (OpenCode Go)`,
    access: known?.access ?? "on_request",
  };
}
