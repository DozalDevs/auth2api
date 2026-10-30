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
  persistInvites,
  persistMembers,
} from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { hashPassword } from "../src/auth/password";

// Drives the real pages in a real browser. Opt in with E2E_BROWSER=<path to a Playwright module>.
const PLAYWRIGHT = process.env.E2E_BROWSER;
const CHANNEL = process.env.E2E_BROWSER_CHANNEL || "chrome";
const SHOTS = process.env.E2E_SHOTS;

test(
  "an admin invites a teammate, the teammate sets a password, asks for a model with a reason, and the admin approves it",
  { skip: !PLAYWRIGHT, timeout: 240_000 },
  async (t) => {
    const { chromium } = require(PLAYWRIGHT as string);
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-acct-"));
    const cfgPath = path.join(authDir, "config.yaml");
    const keys: any[] = [
      {
        name: "boss",
        key: "sk-boss-0123456789abcdef",
        models: ["*"],
        admin: true,
      },
      {
        name: "maria",
        key: "sk-maria-0123456789abcdef",
        models: ["@standard"],
      },
    ];
    const catalog = [
      { id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" },
      {
        id: "go/glm-5.3-flash",
        name: "GLM-5.3 Flash (OpenCode Go)",
        access: "standard",
      },
      { id: "go/kimi-k3", name: "Kimi K3 (OpenCode Go)", access: "on_request" },
      { id: "gpt-6-sol", name: "GPT-6 Sol", access: "on_request" },
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
      persistMembers: persistMembers(cfgPath),
      persistInvites: persistInvites(cfgPath),
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
    const problems: string[] = [];
    const open = async (width = 1280) => {
      const page = await (
        await browser.newContext({ viewport: { width, height: 900 } })
      ).newPage();
      page.on("pageerror", (e: Error) => problems.push(e.message));
      page.on("console", (m: any) => {
        if (/Content Security Policy|Refused to/i.test(m.text()))
          problems.push(m.text());
      });
      return page;
    };
    const toast = (page: any, re: RegExp) =>
      page.waitForFunction(
        (src: string) =>
          new RegExp(src).test(
            document.getElementById("toast")!.textContent || "",
          ),
        re.source,
      );

    // Admin makes the link.
    const admin = await open();
    await admin.goto(`${base}/admin/ui?tab=keys`);
    await admin.fill("#username", "leo@example.com");
    await admin.fill("#password", "correct horse battery");
    await admin.click("#connect");
    await admin.waitForSelector(".krow[data-key=maria]");
    await admin
      .locator(".krow[data-key=maria]")
      .getByRole("button", { name: /More actions/ })
      .click();
    await admin.getByRole("menuitem", { name: "Invite to sign in" }).click();
    await admin.fill("#i-email", "Maria@Example.com");
    await admin.click("#i-save");
    await admin.waitForSelector("#link-panel:not([hidden])");
    const link = (await admin.textContent("#link-value"))!.trim();
    assert.match(link, new RegExp(`^${base}/account#invite=`));
    assert.match(await admin.textContent("#link-note"), /maria@example\.com/);
    assert.match(
      await admin.locator(".krow[data-key=maria]").textContent(),
      /Invite pending/,
    );

    // The teammate opens it and chooses a password.
    const maria = await open();
    await maria.goto(link);
    await maria.waitForSelector("#welcome:not([hidden])");
    await maria.fill("#new-password", "a long enough password");
    await maria.fill("#new-password2", "something different here");
    await maria.click("#welcome-save");
    assert.match(
      await maria.textContent("#welcome-error"),
      /two passwords are different/,
    );
    await maria.fill("#new-password2", "a long enough password");
    await maria.click("#welcome-save");
    await maria.waitForSelector("#page:not([hidden])");
    assert.doesNotMatch(
      maria.url(),
      /invite=/,
      "the one-time link is gone from the address bar once used",
    );
    assert.match(await maria.textContent("#who"), /maria@example\.com/);
    assert.match(await maria.textContent("#canuse"), /You can use 2 models/);
    assert.equal(
      await maria.locator("#requests").isVisible(),
      false,
      "no requests yet, so no empty box",
    );

    // She asks, and the reason is required.
    await maria.click("#ask-open");
    const options = await maria.locator("#ask-model option").allTextContents();
    assert.deepEqual(
      options.sort(),
      ["GPT-6 Sol", "Kimi K3 (OpenCode Go)"].sort(),
    );
    await maria.selectOption("#ask-model", "go/kimi-k3");
    await maria.click("#ask-send");
    assert.match(
      await maria.textContent("#ask-why-hint"),
      /Say why you need it/,
    );
    await maria.fill(
      "#ask-why",
      "Comparing Kimi with GLM for the tax-report summarizer",
    );
    await maria.selectOption("#ask-length", "120");
    if (SHOTS)
      await maria.screenshot({
        path: `${SHOTS}/account-ask-1280.png`,
        fullPage: true,
      });
    await maria.click("#ask-send");
    await toast(maria, /Sent/);
    await maria.waitForSelector("#requests:not([hidden])");
    assert.match(
      await maria.textContent("#requests"),
      /Kimi K3.*Waiting for approval/,
    );

    // The admin sees who, what and why, and approves it.
    await admin.click("#tab-requests");
    await admin.reload();
    await admin.waitForSelector(".rq");
    const card = admin.locator(".rq").first();
    assert.match(
      await card.textContent(),
      /maria[\s\S]*wants Kimi K3 \(OpenCode Go\) for 2 hours/,
    );
    assert.match(
      await card.locator(".rq-why").textContent(),
      /tax-report summarizer/,
    );
    await card.getByRole("button", { name: /^Approve/ }).click();
    await toast(admin, /maria can use Kimi K3/);

    // Her page shows the answer and the loan.
    await maria.reload();
    await maria.waitForSelector("#page:not([hidden])");
    assert.match(await maria.textContent("#canuse"), /You can use 3 models/);
    assert.match(
      await maria.locator("#canuse .loan").textContent(),
      /Kimi K3.*(1h 5\d.m|2h) left/,
    );
    assert.match(await maria.textContent("#requests"), /Approved/);

    // A link from the error message opens the form with the model already chosen.
    await maria.goto(`${base}/account?ask=${encodeURIComponent("gpt-6-sol")}`);
    await maria.waitForSelector("#ask-model");
    assert.equal(await maria.inputValue("#ask-model"), "gpt-6-sol");

    // Set up a computer: the page makes a one-time command, and the key itself is never on the page.
    await maria.click("#setup summary");
    await maria.click("#setup-get");
    await maria.waitForSelector("#setup-body .code");
    const mac = (await maria
      .locator("#setup-body .code")
      .first()
      .textContent())!;
    assert.match(
      mac,
      /^curl -fsSL http\S+\/setup\/opencode\.sh \| RELAY_SETUP_CODE=[A-Za-z0-9_-]+ bash$/,
    );
    assert.match(
      (await maria.locator("#setup-body .code").nth(1).textContent())!,
      /^\$env:RELAY_SETUP_CODE='[A-Za-z0-9_-]+'; .*opencode\.ps1\)\)\)$/,
    );
    const code = mac.match(/RELAY_SETUP_CODE=([A-Za-z0-9_-]+)/)![1];
    const redeemed = await fetch(`${base}/setup/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }).then((r) => r.json());
    assert.equal(redeemed.key, "sk-maria-0123456789abcdef");
    assert.equal(
      (await maria.locator("body").innerText()).includes("sk-maria-"),
      false,
      "the key is never on her page",
    );

    // Signing out and back in works; removing the sign-in locks her out.
    await maria.click("#signout");
    await maria.waitForSelector("#login:not([hidden])");
    await maria.fill("#email", "maria@example.com");
    await maria.fill("#password", "wrong password here");
    await maria.click("#connect");
    await maria.waitForFunction(
      () => document.getElementById("login-error")!.textContent!.length > 0,
    );
    assert.match(
      await maria.textContent("#login-error"),
      /Wrong email or password/,
    );
    await maria.fill("#password", "a long enough password");
    await maria.click("#connect");
    await maria.waitForSelector("#page:not([hidden])");

    await admin.click("#tab-keys");
    await admin
      .locator(".krow[data-key=maria]")
      .getByRole("button", { name: /More actions/ })
      .click();
    await admin.getByRole("menuitem", { name: "Remove sign-in" }).click();
    await admin.click("#confirm-yes");
    await toast(admin, /Removed maria's sign-in/);
    await maria.reload();
    await maria.waitForSelector("#login:not([hidden])");

    assert.deepEqual(
      problems,
      [],
      "no script or security-policy errors on either page",
    );
  },
);
