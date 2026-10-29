import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import { Config, persistApiKeys, persistCatalog } from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { hashPassword } from "../src/auth/password";

// Drives the real dashboard in a real browser. Opt in with E2E_BROWSER=<path to a Playwright module>.
const PLAYWRIGHT = process.env.E2E_BROWSER;
const CHANNEL = process.env.E2E_BROWSER_CHANNEL || "chrome";

test(
  "an admin can pick models in the dropdown, give a time-limited grant, and the relay enforces it",
  { skip: !PLAYWRIGHT, timeout: 240_000 },
  async (t) => {
    const { chromium } = require(PLAYWRIGHT as string);
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-dash-"));
    const cfgPath = path.join(authDir, "config.yaml");
    const keys: any[] = [
      {
        name: "boss",
        key: "sk-boss-0123456789abcdef",
        models: ["*"],
        admin: true,
      },
      {
        name: "carol",
        key: "sk-carol-0123456789abcdef",
        models: ["gpt-6-luna"],
      },
    ];
    const catalog = [
      { id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", access: "on_request" },
      { id: "gpt-6-sol", name: "GPT-6 Sol", access: "standard" },
    ];
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      "auth-dir": authDir,
      "api-keys": keys,
      models: catalog as any,
      "dashboard-users": [
        {
          username: "admin@example.com",
          "password-hash": await hashPassword("correct horse battery"),
        },
      ],
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: false },
      debug: "off",
    };
    let clock = Date.now();
    const app = createServer(config, buildRegistry(authDir), undefined, {
      persistKeys: persistApiKeys(cfgPath),
      persistCatalog: persistCatalog(cfgPath),
      now: () => clock,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ channel: CHANNEL });
    t.after(async () => {
      await browser.close();
      server.close();
      fs.rmSync(authDir, { recursive: true, force: true });
    });

    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    const problems: string[] = [];
    page.on("pageerror", (e: Error) => problems.push(e.message));
    await page.goto(`${base}/admin/ui`);
    await page.fill("#username", "admin@example.com");
    await page.fill("#password", "correct horse battery");
    await page.click("#connect");
    await page.waitForSelector(".krow:not(.head)");
    const row = (name: string) =>
      page.locator(".krow:not(.head)", {
        has: page.locator(".name", { hasText: new RegExp(`^${name}`) }),
      });
    const ask = (key: string, model: string) =>
      fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, messages: [] }),
      }).then(async (r) => ({
        status: r.status,
        body: await r.json().catch(() => null),
      }));

    // 1. The model picker is a multi-select dropdown fed by the model list, with search, and shows friendly names.
    await row("carol").getByRole("button", { name: "Edit" }).click();
    await page.click("#f-models-btn");
    assert.equal(
      await page.locator("#f-models-slot .ms-row").count(),
      3 + 2,
      "three models plus the Any model and All standard models rows",
    );
    await page.fill("#f-models-slot .ms-search", "opus");
    assert.equal(
      await page.locator("#f-models-slot .ms-list .ms-row:visible").count(),
      1,
    );
    await page.fill("#f-models-slot .ms-search", "");
    await page
      .locator("#f-models-slot .ms-row", { hasText: "GPT-6 Sol" })
      .locator("input")
      .check();
    await page.click("#f-models-slot .ms-foot .primary");
    assert.match(await page.textContent("#f-models-btn"), /2 models selected/);
    await page.click("#f-save");
    await page.waitForFunction(() =>
      /Saved/.test(document.getElementById("status")!.textContent || ""),
    );
    assert.equal(
      (await ask("sk-carol-0123456789abcdef", "gpt-6-sol")).body?.error
        ?.type === "model_not_allowed",
      false,
      "Sol now allowed by the edit",
    );

    // 2. Give temporary access to a model she does not have.
    assert.equal(
      (await ask("sk-carol-0123456789abcdef", "claude-opus-5-5")).body.error
        .type,
      "model_not_allowed",
    );
    await row("carol").getByRole("button", { name: "Give access" }).click();
    await page.click("#g-models-btn");
    const options = await page
      .locator("#g-models-slot .ms-list .ms-row .ms-name")
      .allTextContents();
    assert.deepEqual(
      options,
      ["Claude Opus 5.5"],
      "only models she does not already have are offered",
    );
    await page
      .locator("#g-models-slot .ms-row", { hasText: "Claude Opus 5.5" })
      .locator("input")
      .check();
    await page.click("#g-models-slot .ms-foot .primary");
    await page.getByRole("button", { name: "4 hours", exact: true }).click();
    assert.match(
      await page.textContent("#g-preview"),
      /Access ends .* \(4h from now\)/,
    );
    await page.fill("#g-note", "complex UI task");
    await page.click("#g-save");
    await page.waitForFunction(() =>
      /can use Claude Opus 5.5 for 4h/.test(
        document.getElementById("status")!.textContent || "",
      ),
    );
    await page.waitForSelector(".pill .left");
    assert.match(
      await row("carol").locator(".pill .left").first().textContent(),
      /3h 5\d.m left|4h left/,
    );

    // 3. The relay now lets her through to the model, and the list the setup script reads shows it as usable.
    assert.notEqual(
      (await ask("sk-carol-0123456789abcdef", "claude-opus-5-5")).body?.error
        ?.type,
      "model_not_allowed",
    );
    const listed = await (
      await fetch(`${base}/setup/models`, {
        headers: { authorization: "Bearer sk-carol-0123456789abcdef" },
      })
    ).text();
    assert.match(listed, /claude-opus-5-5\tallowed\tClaude Opus 5\.5/);

    // 4. Time passes. The access ends on its own, the error says why, and the setup list marks it "on request" again.
    clock += 4 * 3600_000 + 5 * 60_000;
    const gone = await ask("sk-carol-0123456789abcdef", "claude-opus-5-5");
    assert.equal(gone.status, 403);
    assert.equal(gone.body.error.code, "grant_expired");
    assert.match(
      gone.body.error.message,
      /temporary access to "claude-opus-5-5" ended 5 minutes ago/,
    );
    const relisted = await (
      await fetch(`${base}/setup/models`, {
        headers: { authorization: "Bearer sk-carol-0123456789abcdef" },
      })
    ).text();
    assert.match(
      relisted,
      /claude-opus-5-5\ton_request\tClaude Opus 5\.5 \(on request\)/,
    );
    await page.click("#refresh");
    await page.waitForSelector(".pill.ended");
    assert.match(
      await row("carol").locator(".pill.ended").textContent(),
      /Claude Opus 5\.5.*ended/,
    );

    // 5. End one early from the page.
    await row("carol").getByRole("button", { name: "Give access" }).click();
    await page.click("#g-models-btn");
    await page
      .locator("#g-models-slot .ms-row", { hasText: "Claude Opus 5.5" })
      .locator("input")
      .check();
    await page.click("#g-models-slot .ms-foot .primary");
    await page.getByRole("button", { name: "2 hours", exact: true }).click();
    await page.click("#g-save");
    await page.waitForSelector(".pill .left");
    assert.notEqual(
      (await ask("sk-carol-0123456789abcdef", "claude-opus-5-5")).body?.error
        ?.type,
      "model_not_allowed",
    );
    page.once("dialog", (d: any) => d.accept());
    await row("carol")
      .getByRole("button", { name: "End access to Claude Opus 5.5 for carol" })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll(".pill .left").length === 0,
    );
    assert.equal(
      (await ask("sk-carol-0123456789abcdef", "claude-opus-5-5")).body.error
        .type,
      "model_not_allowed",
    );

    // 5b. A key that already has every model shows a greyed-out Give access and says why, instead of hiding it.
    const bossGive = row("boss").getByRole("button", { name: "Give access" });
    assert.equal(
      await bossGive.count(),
      1,
      "the button is visible on a key with every model",
    );
    assert.equal(await bossGive.isDisabled(), true);
    assert.match(await row("boss").textContent(), /Already has every model/);
    assert.equal(
      await row("carol")
        .getByRole("button", { name: "Give access" })
        .isDisabled(),
      false,
    );

    // 5c. "All standard models" is one tick in the dropdown, and it follows the model list.
    await row("carol").getByRole("button", { name: "Edit" }).click();
    await page.click("#f-models-btn");
    await page
      .locator("#f-models-slot .ms-any", { hasText: "All standard models" })
      .locator("input")
      .check();
    await page.click("#f-models-slot .ms-foot .primary");
    assert.match(
      await page.textContent("#f-models-btn"),
      /Standard \+ \d+ more|All standard models/,
    );
    await page.click("#f-save");
    await page.waitForFunction(() =>
      /Saved/.test(document.getElementById("status")!.textContent || ""),
    );
    assert.match(
      await row("carol").locator(".chips").textContent(),
      /All standard models/,
    );
    assert.equal(
      (await ask("sk-carol-0123456789abcdef", "gpt-6-sol")).body?.error
        ?.type === "model_not_allowed",
      false,
      "a standard model is open through the group",
    );
    assert.equal(
      (await ask("sk-carol-0123456789abcdef", "claude-opus-5-5")).body.error
        .type,
      "model_not_allowed",
      "an on-request model is not",
    );

    // 5d. With no OpenCode Go keys on the relay the sync button is not offered at all.
    assert.equal(await page.locator("#go-sync").count(), 0);

    // 6. Add a model to the list from the page.
    await page.fill("#m-id", "claude-sonnet-5-5");
    await page.fill("#m-name", "Claude Sonnet 5.5");
    await page.click("#m-add");
    await page.waitForFunction(() =>
      /Added Claude Sonnet 5.5/.test(
        document.getElementById("status")!.textContent || "",
      ),
    );
    const modelRows = await page
      .locator("#models .mrow:not(.head) .name")
      .allTextContents();
    assert.equal(
      modelRows.length,
      4,
      `model rows: ${JSON.stringify(modelRows)}`,
    );
    assert.deepEqual(problems, [], "no script errors in the page");
  },
);

test(
  "with OpenCode Go connected the page offers one button that adds Go's models, cheap ones as standard",
  { skip: !PLAYWRIGHT, timeout: 240_000 },
  async (t) => {
    const { chromium } = require(PLAYWRIGHT as string);
    const http = require("node:http");
    const goServer = http.createServer((_req: any, res: any) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "glm-5.3-flash" },
            { id: "kimi-k3" },
            { id: "muse-spark-1.3-contributor" },
          ],
        }),
      );
    });
    await new Promise<void>((r) => goServer.listen(0, "127.0.0.1", r));
    const goUrl = `http://127.0.0.1:${(goServer.address() as AddressInfo).port}`;
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-go-"));
    const cfgPath = path.join(authDir, "config.yaml");
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      "auth-dir": authDir,
      "api-keys": [
        {
          name: "boss",
          key: "sk-boss-0123456789abcdef",
          models: ["*"],
          admin: true,
        },
      ],
      "opencode-go": {
        keys: ["go-key-AAAAAAAAAAAAAAAAAAAA", "go-key-BBBBBBBBBBBBBBBBBBBB"],
        "base-url": goUrl,
      },
      "dashboard-users": [
        {
          username: "admin@example.com",
          "password-hash": await hashPassword("correct horse battery"),
        },
      ],
      "body-limit": "1mb",
      cloaking: {},
      timeouts: {
        "messages-ms": 1000,
        "stream-messages-ms": 1000,
        "count-tokens-ms": 1000,
      },
      stats: { enabled: false },
      debug: "off",
    };
    const app = createServer(config, buildRegistry(authDir), undefined, {
      persistKeys: persistApiKeys(cfgPath),
      persistCatalog: persistCatalog(cfgPath),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ channel: CHANNEL });
    t.after(async () => {
      await browser.close();
      server.close();
      goServer.close();
      fs.rmSync(authDir, { recursive: true, force: true });
    });
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    await page.goto(`${base}/admin/ui`);
    await page.fill("#username", "admin@example.com");
    await page.fill("#password", "correct horse battery");
    await page.click("#connect");
    await page.waitForSelector("#go-sync");
    assert.match(
      await page.textContent("#go-sync-box"),
      /connected with 2 keys/,
    );
    assert.equal(
      await page
        .textContent("body")
        .then((b: string) => b.includes("go-key-AAAA")),
      false,
      "no key is ever shown on the page",
    );

    await page.click("#go-sync");
    await page.waitForFunction(() =>
      /Added 2 OpenCode Go models/.test(
        document.getElementById("status")!.textContent || "",
      ),
    );
    const cheap = page
      .locator("#models .mrow", { hasText: "GLM-5.3 Flash (OpenCode Go)" })
      .locator("select");
    const dear = page
      .locator("#models .mrow", { hasText: "Kimi K3 (OpenCode Go)" })
      .locator("select");
    assert.equal(await cheap.inputValue(), "standard");
    assert.equal(await dear.inputValue(), "on_request");
    assert.equal(
      await page.locator("#models .mrow", { hasText: "muse-spark" }).count(),
      0,
      "a model Go trains on is never offered",
    );

    await page.click("#go-sync");
    await page.waitForFunction(() =>
      /already has every OpenCode Go model/.test(
        document.getElementById("status")!.textContent || "",
      ),
    );
  },
);
