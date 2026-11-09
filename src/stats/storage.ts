import fs from "fs";
import path from "path";
import type { StatsEvent } from "./recorder";

/**
 * Storage layer for the stats subsystem. The on-disk format is JSONL —
 * one event per line — appended via a long-lived write stream so request
 * latency isn't blocked on fsync. The file is the source of truth: the
 * in-memory aggregate is rebuilt from it on startup.
 */

export const STATS_FILENAME = "stats.jsonl";

export function statsFilePath(authDir: string): string {
  return path.join(authDir, STATS_FILENAME);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProvider(value: unknown): boolean {
  return value === "anthropic" || value === "codex" || value === "cursor";
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsage(value: unknown): boolean {
  if (value === null) return true;
  if (!isObject(value)) return false;
  return (
    isFiniteNumber(value.inputTokens) &&
    isFiniteNumber(value.outputTokens) &&
    isFiniteNumber(value.cacheCreationInputTokens) &&
    isFiniteNumber(value.cacheReadInputTokens) &&
    isFiniteNumber(value.reasoningOutputTokens)
  );
}

function isStatsEvent(value: unknown): value is StatsEvent {
  if (!isObject(value)) return false;
  return (
    value.v === 1 &&
    typeof value.ts === "string" &&
    typeof value.apiKeyHash === "string" &&
    typeof value.ip === "string" &&
    typeof value.ua === "string" &&
    typeof value.endpoint === "string" &&
    isNullableString(value.model) &&
    (value.provider === null || isProvider(value.provider)) &&
    isNullableString(value.accountEmail) &&
    (value.status === "success" || value.status === "failure") &&
    isNullableString(value.failureKind) &&
    isFiniteNumber(value.statusCode) &&
    isFiniteNumber(value.latencyMs) &&
    isUsage(value.usage)
  );
}

const REPLAY_CHUNK_BYTES = 1024 * 1024;

/**
 * Replay every persisted event into `apply` synchronously. Corrupted lines
 * (partial writes after a crash, manual edits, schema mismatches) are
 * skipped so a single bad line doesn't poison the entire history.
 *
 * The file is read in fixed-size chunks, never whole: reading it whole kept
 * the full text plus every split line in memory at once, which is how a
 * 218 MB log ran a 512 MB relay out of memory at boot.
 */
export function replayStatsEvents(
  filePath: string,
  apply: (event: StatsEvent) => void,
): { lines: number; skipped: number } {
  if (!fs.existsSync(filePath)) return { lines: 0, skipped: 0 };
  let lines = 0;
  let skipped = 0;
  const handle = (line: string): void => {
    if (!line) return;
    lines++;
    try {
      const event = JSON.parse(line);
      if (!isStatsEvent(event)) {
        skipped++;
        return;
      }
      apply(event);
    } catch {
      skipped++;
    }
  };
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(REPLAY_CHUNK_BYTES);
  let carry: Buffer = Buffer.alloc(0);
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      let chunk = carry.length
        ? Buffer.concat([carry, buf.subarray(0, read)])
        : buf.subarray(0, read);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start);
        if (nl === -1) break;
        handle(chunk.toString("utf-8", start, nl));
        start = nl + 1;
      }
      carry = Buffer.from(chunk.subarray(start));
    }
    if (carry.length) handle(carry.toString("utf-8"));
  } finally {
    fs.closeSync(fd);
  }
  return { lines, skipped };
}

/** The summary that holds every compacted event's totals; see StatsRecorder.compact(). */
export const STATS_SUMMARY_FILENAME = "stats.summary.json";

export function statsSummaryPath(authDir: string): string {
  return path.join(authDir, STATS_SUMMARY_FILENAME);
}

/** A log rotated out for compaction, named by the generation that will summarise it. */
export function rotatedStatsPath(authDir: string, gen: number): string {
  return path.join(authDir, `stats.${gen}.jsonl`);
}

/** Generations of rotated logs left in `authDir` (normally none: a crash mid-compaction leaves one). */
export function listRotatedGenerations(authDir: string): number[] {
  if (!fs.existsSync(authDir)) return [];
  return fs
    .readdirSync(authDir)
    .map((name) => /^stats\.(\d+)\.jsonl$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

/** Write `data` to `filePath` atomically (temp file, then rename), readable by the operator only. */
export function writeFileAtomic(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/**
 * Append-only writer kept open for the lifetime of the recorder so each
 * event is a single non-blocking `stream.write()`. The 0o600 permission
 * matches token files — the JSONL contains hashed API keys + IPs which
 * we'd rather keep readable only by the operator.
 */
export class StatsAppender {
  private stream: fs.WriteStream | null = null;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  open(): void {
    if (this.stream) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    // 0o600 only takes effect on file creation; pre-existing files keep
    // their mode. That's fine — the parent dir is 0o700.
    // Open the file now, not lazily by path: compaction renames the log away and
    // the stream must keep writing to the file it opened, never to its successor.
    const fd = fs.openSync(this.filePath, "a", 0o600);
    this.stream = fs.createWriteStream("", { fd, flags: "a" });
    this.stream.on("error", (err) => {
      console.error("[stats] write stream error:", err.message);
    });
  }

  append(event: StatsEvent): void {
    if (!this.stream) this.open();
    this.stream!.write(JSON.stringify(event) + "\n");
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
      this.stream = null;
    });
  }
}
