import http from "node:http";
import { AddressInfo } from "node:net";

export const KEYS = {
  luna: "sk-luna-0123456789abcdef0123",
  wide: "sk-wide-0123456789abcdef0123",
  capped: "sk-capped-0123456789abcdef0123",
  off: "sk-off-0123456789abcdef0123",
} as const;

const LUNA = ["gpt-6-luna", "gpt-5.6-luna"];
const WIDE = [...LUNA, "gpt-6-sol", "gpt-5.6-sol", "gpt-6-astra"];
const NOT_SERVED = ["gpt-6.1-sol", "gpt-6.1-terra"];

export interface MockRelay {
  url: string;
  calls: { method: string; path: string; model?: string }[];
  close(): Promise<void>;
}

export async function startMockRelay(): Promise<MockRelay> {
  const calls: MockRelay["calls"] = [];
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const key = (req.headers.authorization || "").replace(/^Bearer /, "");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {}
      calls.push({ method: req.method || "", path: req.url || "", model: body.model });
      if (req.url === "/health") return json(200, { status: "ok" });
      if (!key) return json(401, { error: { message: "Missing API key" } });
      const known = Object.values(KEYS).includes(key as any);
      if (!known) return json(403, { error: { message: "Invalid API key" } });
      if (key === KEYS.off) return json(403, { error: { message: "API key disabled" } });
      if (req.url === "/v1/models" && req.method === "GET") return json(200, { object: "list", data: [] });
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        const allowed = key === KEYS.wide ? WIDE : LUNA;
        const model = String(body.model || "");
        if (NOT_SERVED.includes(model)) {
          return json(400, { error: { message: `The '${model}' model is not supported when using Codex with a ChatGPT account.` } });
        }
        if (!allowed.includes(model)) {
          return json(403, { error: { message: `model "${model}" is not enabled for this key`, type: "model_not_allowed" } });
        }
        if (key === KEYS.capped) {
          return json(429, { error: { message: "daily token limit reached for this key", type: "daily_token_limit" } });
        }
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (delta: object, finish: string | null) =>
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
          res.write(chunk({ role: "assistant", content: "" }, null));
          res.write(chunk({ content: "relay works" }, null));
          res.write(chunk({}, "stop"));
          res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        return json(200, {
          id: "c1",
          object: "chat.completion",
          created: 1,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
      }
      return json(404, { error: { message: "not found" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
