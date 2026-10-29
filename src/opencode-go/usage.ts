import { UsageData } from "../accounts/manager";

/**
 * Reads token usage out of an OpenAI chat, OpenAI Responses or Anthropic
 * Messages reply, streamed or not, without caring which one it is. Each shape
 * puts the numbers somewhere slightly different, so every object that looks
 * like a usage block is merged in, keeping the largest figure seen (streams
 * report running totals).
 */
export class UsageScanner {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheCreate = 0;
  private reasoning = 0;
  private found = false;
  private tail = "";

  /** Feed raw bytes of a streamed (server-sent events) reply. */
  feed(chunk: Uint8Array): void {
    this.tail += Buffer.from(chunk).toString("utf8");
    let at: number;
    while ((at = this.tail.indexOf("\n")) >= 0) {
      this.line(this.tail.slice(0, at));
      this.tail = this.tail.slice(at + 1);
    }
  }

  /** Call once after the last chunk so a final line without a newline counts. */
  end(): void {
    if (this.tail) this.line(this.tail);
    this.tail = "";
  }

  /** Feed a complete JSON reply. */
  whole(text: string): void {
    try {
      this.visit(JSON.parse(text));
    } catch {
      /* not JSON: nothing to count */
    }
  }

  usage(): UsageData | null {
    if (!this.found) return null;
    return {
      inputTokens: this.input,
      outputTokens: this.output,
      cacheCreationInputTokens: this.cacheCreate,
      cacheReadInputTokens: this.cacheRead,
      reasoningOutputTokens: this.reasoning,
    };
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      this.visit(JSON.parse(data));
    } catch {
      /* a partial or non-JSON event */
    }
  }

  private visit(obj: any): void {
    if (!obj || typeof obj !== "object") return;
    for (const u of [obj.usage, obj.message?.usage, obj.response?.usage]) {
      if (u && typeof u === "object") this.merge(u);
    }
  }

  private merge(u: any): void {
    const num = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    const input = num(u.prompt_tokens) ?? num(u.input_tokens);
    const output = num(u.completion_tokens) ?? num(u.output_tokens);
    if (input === undefined && output === undefined) return;
    this.found = true;
    this.input = Math.max(this.input, input ?? 0);
    this.output = Math.max(this.output, output ?? 0);
    this.cacheRead = Math.max(
      this.cacheRead,
      num(u.prompt_tokens_details?.cached_tokens) ??
        num(u.input_tokens_details?.cached_tokens) ??
        num(u.cache_read_input_tokens) ??
        0,
    );
    this.cacheCreate = Math.max(
      this.cacheCreate,
      num(u.cache_creation_input_tokens) ?? 0,
    );
    this.reasoning = Math.max(
      this.reasoning,
      num(u.completion_tokens_details?.reasoning_tokens) ??
        num(u.output_tokens_details?.reasoning_tokens) ??
        0,
    );
  }
}
