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
    await page.goto(`${base}/admin/ui?tab=keys`);
    await page.fill("#username", "admin@example.com");
    await page.fill("#password", "correct horse battery");
    await page.click("#connect");
    await page.waitForSelector(".krow[data-key]");
    const row = (name: string) => page.locator(`.krow[data-key="${name}"]`);
    const toast = (re: RegExp) =>
      page.waitForFunction(
        (src: string) =>
          new RegExp(src).test(
            document.getElementById("toast")!.textContent || "",
          ),
        re.source,
      );
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
    const menuItem = async (name: string, item: string) => {
      await row(name)
        .getByRole("button", { name: /More actions/ })
        .click();
      await page.getByRole("menuitem", { name: item }).click();
    };

    // 1. The model picker is a multi-select dropdown fed by the model list, with search, and shows friendly names.
    await menuItem("carol", "Edit access and limit");
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
    await toast(/Saved carol/);
    assert.equal(
      (await ask("sk-carol-0123456789abcdef", "gpt-6-sol")).body?.error
        ?.type === "model_not_allowed",
      false,
      "Sol now allowed by the edit",
    );

    // 2. Give temporary access to a model she does not have, from a form that opens right under her row.
    assert.equal(
      (await ask("sk-carol-0123456789abcdef", "claude-opus-5-5")).body.error
        .type,
      "model_not_allowed",
    );
    await row("carol")
      .getByRole("button", { name: /Give carol temporary access/ })
      .click();
    assert.equal(
      await page.locator(".krow[data-key=carol] + #grant-form").count(),
      1,
      "the form sits directly under her row",
    );
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
    assert.match(await page.textContent("#g-preview"), /Ends .* \(in 4h\)/);
    await page.fill("#g-note", "complex UI task");
    await page.click("#g-save");
    await toast(/can use Claude Opus 5.5 for 4h/);
    await page.waitForSelector(".loan .left");
    assert.match(
      await row("carol").locator(".loan .left").first().textContent(),
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
    await page.goto(`${base}/admin/ui?tab=keys`);
    await page.waitForSelector(".krow[data-key=carol]");
    assert.equal(
      await row("carol").locator(".loan").count(),
      0,
      "the ended loan is gone from her row",
    );

    // 5. End one early from the page; the confirm says what happens and the button names the verb.
    await row("carol")
      .getByRole("button", { name: /Give carol temporary access/ })
      .click();
    await page.click("#g-models-btn");
    await page
      .locator("#g-models-slot .ms-row", { hasText: "Claude Opus 5.5" })
      .locator("input")
      .check();
    await page.click("#g-models-slot .ms-foot .primary");
    await page.getByRole("button", { name: "2 hours", exact: true }).click();
    await page.click("#g-save");
    await page.waitForSelector(".loan .left");
    assert.notEqual(
      (await ask("sk-carol-0123456789abcdef", "claude-opus-5-5")).body?.error
        ?.type,
      "model_not_allowed",
    );
    await row("carol")
      .getByRole("button", { name: "End carol's access to Claude Opus 5.5" })
      .click();
    assert.match(
      await page.textContent("#confirm-body"),
      /loses it right away/,
    );
    await page.click("#confirm-no");
    assert.equal(
      await row("carol").locator(".loan").count(),
      1,
      "Keep it leaves the loan alone",
    );
    await row("carol")
      .getByRole("button", { name: "End carol's access to Claude Opus 5.5" })
      .click();
    await page.click("#confirm-yes");
    await page.waitForFunction(
      () => document.querySelectorAll(".loan .left").length === 0,
    );
    assert.equal(
      (await ask("sk-carol-0123456789abcdef", "claude-opus-5-5")).body.error
        .type,
      "model_not_allowed",
    );

    // 5b. A key that already has every model has nothing to lend, so it offers Edit instead of a dead Give access.
    assert.equal(
      await row("boss")
        .getByRole("button", { name: /Give boss temporary access/ })
        .count(),
      0,
    );
    assert.equal(
      await row("boss").getByRole("button", { name: "Edit boss" }).count(),
      1,
    );
    assert.match(await row("boss").textContent(), /Every model/);

    // 5c. "All standard models" is one tick in the dropdown, and it follows the model list.
    await menuItem("carol", "Edit access and limit");
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
    await toast(/Saved carol/);
    assert.match(
      await row("carol").locator(".k-access").textContent(),
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
    await page.click("#tab-models");
    assert.equal(await page.locator("#go-sync").isVisible(), false);

    // 6. Add a model to the list from the page.
    await page.click("#add-model");
    await page.fill("#m-id", "claude-sonnet-5-5");
    await page.fill("#m-name", "Claude Sonnet 5.5");
    await page.click("#m-add");
    await toast(/Added Claude Sonnet 5.5/);
    const modelRows = await page
      .locator("#models .mrow .m-name")
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
    await page.goto(`${base}/admin/ui?tab=models`);
    await page.fill("#username", "admin@example.com");
    await page.fill("#password", "correct horse battery");
    await page.click("#connect");
    await page.waitForSelector("#go-sync:visible");
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
        document.getElementById("toast")!.textContent || "",
      ),
    );
    const firstMenuItem = async (name: string) => {
      const row = page.locator("#models .mrow", { hasText: name });
      await row.getByRole("button", { name: /Actions for/ }).click();
      const text = await row.getByRole("menuitem").first().textContent();
      await page.keyboard.press("Escape");
      return text;
    };
    assert.equal(
      await firstMenuItem("GLM-5.3 Flash"),
      "Make on request",
      "the cheap model is standard",
    );
    assert.equal(
      await firstMenuItem("Kimi K3"),
      "Make standard",
      "the dear model is on request",
    );
    assert.equal(
      await page.locator("#models .mrow", { hasText: "muse-spark" }).count(),
      0,
      "a model Go trains on is never offered",
    );

    await page.click("#go-sync");
    await page.waitForFunction(() =>
      /already have every OpenCode Go model/.test(
        document.getElementById("toast")!.textContent || "",
      ),
    );
  },
);
