import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import {
  Config,
  persistAccessRequests,
  persistApiKeys,
  persistCatalog,
} from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { hashPassword } from "../src/auth/password";

// Drives the real dashboard in a real browser. Opt in with E2E_BROWSER=<path to a Playwright module>.
const PLAYWRIGHT = process.env.E2E_BROWSER;
const CHANNEL = process.env.E2E_BROWSER_CHANNEL || "chrome";
const SHOTS = process.env.E2E_SHOTS;

test(
  "an admin sees who asked for what and why, approves or rejects in the dashboard, and new keys start on standard models",
  { skip: !PLAYWRIGHT, timeout: 240_000 },
  async (t) => {
    const { chromium } = require(PLAYWRIGHT as string);
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-req-"));
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
        models: ["@standard"],
      },
    ];
    const catalog = [
      { id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", access: "on_request" },
      { id: "kimi-k3", name: "Kimi K3", access: "on_request" },
    ];
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      "auth-dir": authDir,
      "api-keys": keys,
      models: catalog as any,
      "dashboard-users": [
        {
          username: "leo@example.com",
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
      persistRequests: persistAccessRequests(cfgPath),
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

    const carol = (p: string, method = "GET", body?: unknown) =>
      fetch(base + p, {
        method,
        headers: {
          authorization: "Bearer sk-carol-0123456789abcdef",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const ask = (model: string) =>
      carol("/v1/chat/completions", "POST", { model, messages: [] });

    const opus = await carol("/access-requests", "POST", {
      model: "claude-opus-5-5",
      reason:
        "Reviewing the dashboard redesign: I need to compare it against Opus output",
      hours: 8,
    });
    assert.equal(opus.status, 201);
    const kimi = await carol("/access-requests", "POST", {
      model: "kimi-k3",
      reason: "just curious",
    });
    assert.equal(kimi.status, 201);

    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    const problems: string[] = [];
    page.on("pageerror", (e: Error) => problems.push(e.message));
    const toast = (re: RegExp) =>
      page.waitForFunction(
        (src: string) =>
          new RegExp(src).test(
            document.getElementById("toast")!.textContent || "",
          ),
        re.source,
      );
    await page.goto(`${base}/admin/ui`);
    await page.fill("#username", "leo@example.com");
    await page.fill("#password", "correct horse battery");
    await page.click("#connect");
    await page.waitForSelector(".rq");

    assert.equal(
      await page.getAttribute("#tab-requests", "aria-selected"),
      "true",
      "with requests waiting, the first thing you see is the requests",
    );
    assert.equal((await page.textContent("#req-count")).trim(), "2");
    const cards = page.locator("#requests .rq");
    assert.equal(await cards.count(), 2);
    const opusCard = cards.filter({ hasText: "Claude Opus 5.5" });
    assert.match(
      await opusCard.textContent(),
      /carol[\s\S]*wants Claude Opus 5\.5 for 8 hours/,
    );
    assert.match(
      await opusCard.locator(".rq-why").textContent(),
      /Reviewing the dashboard redesign/,
      "the reason is on the card",
    );
    assert.equal(
      await opusCard.getByRole("button", { name: /^Approve/ }).textContent(),
      "Approve for 8 hours",
      "the button says what approving does",
    );
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/requests-1440.png` });
      await page.setViewportSize({ width: 375, height: 800 });
      await page.screenshot({ path: `${SHOTS}/requests-375.png` });
      await page.setViewportSize({ width: 1280, height: 900 });
    }

    assert.equal(
      (await ask("claude-opus-5-5")).body.error.type,
      "model_not_allowed",
    );
    await opusCard
      .getByRole("button", { name: "Change time or add a note" })
      .click();
    await opusCard
      .getByLabel("How long to lend it to carol")
      .selectOption("120");
    assert.equal(
      await opusCard.getByRole("button", { name: /^Approve/ }).textContent(),
      "Approve for 2 hours",
      "the button follows the chosen length",
    );
    await opusCard.getByPlaceholder("Note for carol").fill("fine, two hours");
    await opusCard.getByRole("button", { name: /^Approve/ }).click();
    await toast(/carol can use Claude Opus 5.5 for 2 hours/);
    assert.notEqual(
      (await ask("claude-opus-5-5")).body?.error?.type,
      "model_not_allowed",
      "approving in the dashboard opens it at once",
    );
    assert.equal((await page.textContent("#req-count")).trim(), "1");

    await page.getByText("Recent decisions").click();
    assert.match(
      await page.textContent("#requests"),
      /Approved · carol · Claude Opus 5\.5 · 1h 59m left|Approved · carol · Claude Opus 5\.5 · 2h left/,
    );

    const kimiCard = page
      .locator("#requests .rq")
      .filter({ hasText: "Kimi K3" });
    await kimiCard
      .getByRole("button", { name: "Change time or add a note" })
      .click();
    await kimiCard.getByPlaceholder("Note for carol").fill("use luna");
    await kimiCard.getByRole("button", { name: "Reject" }).click();
    await toast(/Rejected carol's request/);
    assert.equal(await page.locator("#req-count").isVisible(), false);
    assert.match(await page.textContent("#requests"), /No requests waiting/);
    assert.match(
      await page.textContent("#requests"),
      /Rejected · carol · Kimi K3 · use luna/,
    );
    assert.equal((await ask("kimi-k3")).body.error.type, "model_not_allowed");
    const mine = await carol("/access-requests");
    assert.deepEqual(
      mine.body.requests.map((r: any) => [r.status, r.decision_note]).sort(),
      [
        ["approved", "fine, two hours"],
        ["rejected", "use luna"],
      ],
    );

    await page.click("#tab-keys");
    assert.match(
      await page.locator(".krow[data-key=carol] .loan").textContent(),
      /Claude Opus 5\.5/,
      "the loan shows on carol's row",
    );
    await page.click("#add-key");
    assert.match(
      await page.textContent("#f-models-btn"),
      /All standard models/,
      "a new key starts on the standard models",
    );
    await page.fill("#f-name", "newbie");
    await page.click("#f-save");
    await page.waitForSelector("#secret-panel:not([hidden])");
    assert.match(
      await page.locator(".krow[data-key=newbie] .k-access").textContent(),
      /All standard models/,
    );

    // The tab and the period live in the address bar, so a link or a refresh lands on the same screen and Back works.
    await page.click("#tab-usage");
    await page.getByRole("button", { name: "7 days" }).click();
    assert.match(page.url(), /tab=usage/);
    assert.match(page.url(), /days=7/);
    await page.reload();
    await page.waitForSelector("#panel-usage:not([hidden])");
    assert.equal(
      await page.getAttribute(
        '.seg[aria-label=Period] [data-days="7"]',
        "aria-pressed",
      ),
      "true",
    );
    await page.goBack();
    assert.doesNotMatch(
      page.url(),
      /days=7/,
      "the period change replaced itself, it did not stack",
    );
    await page.waitForSelector("#panel-keys:not([hidden])");

    // Tabs work from the keyboard.
    await page.focus("#tab-keys");
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.getAttribute("#tab-models", "aria-selected"),
      "true",
    );
    await page.keyboard.press("Home");
    assert.equal(
      await page.getAttribute("#tab-requests", "aria-selected"),
      "true",
    );

    assert.deepEqual(problems, [], "no script errors on the page");
  },
);
