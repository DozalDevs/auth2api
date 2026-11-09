import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { StatsRecorder, StatsEvent } from "../src/stats/recorder";
import { replayStatsEvents, statsFilePath } from "../src/stats/storage";

function event(i: number, over: Partial<StatsEvent> = {}): StatsEvent {
  return {
    v: 1,
    ts: new Date(Date.UTC(2026, 10, 1 + (i % 7), 0, 0, i % 60)).toISOString(),
    apiKeyHash: `key${i % 3}`.padEnd(64, "0"),
    ip: "10.0.0.1",
    ua: "test",
    endpoint: "/v1/chat/completions",
    model: i % 2 ? "codex/gpt-5.6-luna" : "codex/gpt-5.6",
    provider: "codex",
    accountEmail: "staff@example.com",
    status: i % 10 === 0 ? "failure" : "success",
    failureKind: null,
    statusCode: i % 10 === 0 ? 429 : 200,
    latencyMs: 100 + (i % 50),
    usage: {
      inputTokens: 1000 + i,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 300,
      reasoningOutputTokens: 7,
    },
    ...over,
  };
}

const tmpDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-stats-bounded-"));

test("replay of a stats file larger than the heap limit streams instead of loading it whole", () => {
  // The production relay died on boot when its 218 MB stats.jsonl was read whole into memory.
  // Here a ~48 MB file must replay inside a 48 MB old-space heap: only a streaming reader fits.
  const tmp = tmpDir();
  try {
    const file = path.join(tmp, "stats.jsonl");
    const fd = fs.openSync(file, "w");
    const line = JSON.stringify(event(1)) + "\n";
    const lines = Math.ceil((48 * 1024 * 1024) / line.length);
    const block = line.repeat(1000);
    for (let n = 0; n < lines; n += 1000) fs.writeSync(fd, block);
    fs.closeSync(fd);
    const script = `
      const { replayStatsEvents } = require(${JSON.stringify(path.resolve(__dirname, "../src/stats/storage.ts"))});
      let n = 0;
      const r = replayStatsEvents(${JSON.stringify(file)}, () => { n++; });
      process.stdout.write(JSON.stringify({ n, lines: r.lines, skipped: r.skipped }));
    `;
    const res = spawnSync(
      process.execPath,
      ["--max-old-space-size=48", "--import", "tsx", "-e", script],
      {
        encoding: "utf8",
        cwd: path.resolve(__dirname, ".."),
        timeout: 120_000,
      },
    );
    assert.equal(
      res.status,
      0,
      `replay crashed under a 48 MB heap: ${res.stderr.slice(-400)}`,
    );
    const out = JSON.parse(res.stdout);
    assert.equal(out.skipped, 0);
    assert.equal(out.n, out.lines);
    assert.ok(out.lines >= lines);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("replay handles a final line with no newline and lines split across read chunks", () => {
  const tmp = tmpDir();
  try {
    const file = path.join(tmp, "stats.jsonl");
    const many = Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify(event(i)),
    ).join("\n");
    fs.writeFileSync(file, many);
    let n = 0;
    const r = replayStatsEvents(file, () => {
      n++;
    });
    assert.equal(n, 5000);
    assert.equal(r.lines, 5000);
    assert.equal(r.skipped, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("compaction keeps every stats view identical across a restart and empties the event log", async () => {
  const tmp = tmpDir();
  try {
    const a = new StatsRecorder();
    a.start(tmp);
    for (let i = 0; i < 300; i++) a.applyEventAndAppendForTest(event(i));
    await a.stop();
    const before = new StatsRecorder();
    before.start(tmp);
    const snapBefore = before.getSnapshot();
    const rowsBefore = before.usageRows();
    await before.stop();
    assert.equal(snapBefore.totals.requests, 300);

    // A boot compacts: the views come back the same from the summary, and the log holds nothing old.
    const after = new StatsRecorder();
    after.start(tmp);
    assert.deepEqual(after.getSnapshot(), snapBefore);
    assert.deepEqual(after.usageRows(), rowsBefore);
    await after.stop();
    assert.equal(fs.statSync(statsFilePath(tmp)).size, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the event log is compacted while running once it passes the event threshold", async () => {
  const tmp = tmpDir();
  try {
    const r = new StatsRecorder({ compactEvery: 100 });
    r.start(tmp);
    for (let i = 0; i < 250; i++) r.applyEventAndAppendForTest(event(i));
    await r.flushForTest();
    const lines = fs
      .readFileSync(statsFilePath(tmp), "utf8")
      .split("\n")
      .filter(Boolean).length;
    assert.ok(
      lines <= 100,
      `log holds ${lines} events after compaction, expected at most 100`,
    );
    const snap = r.getSnapshot();
    await r.stop();
    const again = new StatsRecorder();
    again.start(tmp);
    assert.deepEqual(again.getSnapshot(), snap);
    await again.stop();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a crash between rotating the log and writing the summary loses and doubles nothing", async () => {
  const tmp = tmpDir();
  try {
    const a = new StatsRecorder();
    a.start(tmp);
    for (let i = 0; i < 50; i++) a.applyEventAndAppendForTest(event(i));
    await a.stop();
    // Simulate the crash window: the log was rotated to the next generation but no summary covers it yet.
    const ref = new StatsRecorder();
    ref.start(tmp);
    const expected = ref.getSnapshot();
    await ref.stop();
    const summary = JSON.parse(
      fs.readFileSync(path.join(tmp, "stats.summary.json"), "utf8"),
    );
    for (let i = 50; i < 60; i++) {
      fs.appendFileSync(statsFilePath(tmp), JSON.stringify(event(i)) + "\n");
    }
    fs.renameSync(
      statsFilePath(tmp),
      path.join(tmp, `stats.${summary.gen + 1}.jsonl`),
    );
    // And a stale rotated file the summary already covers must not be replayed again.
    fs.writeFileSync(
      path.join(tmp, `stats.${summary.gen}.jsonl`),
      JSON.stringify(event(1)) + "\n",
    );

    const b = new StatsRecorder();
    b.start(tmp);
    const snap = b.getSnapshot();
    await b.stop();
    assert.equal(snap.totals.requests, expected.totals.requests + 10);
    assert.equal(
      fs.existsSync(path.join(tmp, `stats.${summary.gen}.jsonl`)),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(tmp, `stats.${summary.gen + 1}.jsonl`)),
      false,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
