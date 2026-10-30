import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import {
  Config,
  persistAccessRequests,
  persistAdminInvites,
  persistApiKeys,
  persistCatalog,
  persistDashboardUsers,
  persistInvites,
  persistMembers,
} from "../src/config";
import { createServer } from "../src/server";
import { buildRegistry } from "../src/providers/registry";
import { hashPassword } from "../src/auth/password";

// Drives the real dashboard in a real browser. Opt in with E2E_BROWSER=<path to a Playwright module>.
const PLAYWRIGHT = process.env.E2E_BROWSER;
const CHANNEL = process.env.E2E_BROWSER_CHANNEL || "chrome";
const SHOTS = process.env.E2E_SHOTS;

test(
  "an admin invites another admin, who gets a personal login, and the shared login can then be removed",
  { skip: !PLAYWRIGHT, timeout: 240_000 },
  async (t) => {
    const { chromium } = require(PLAYWRIGHT as string);
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-team-"));
    const cfgPath = path.join(authDir, "config.yaml");
    const keys: any[] = [
      {
        name: "boss",
        key: "sk-boss-0123456789abcdef",
        models: ["*"],
        admin: true,
      },
    ];
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      "auth-dir": authDir,
      "api-keys": keys,
      models: [
        { id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" },
      ] as any,
      "dashboard-users": [
        {
          username: "victor@example.com",
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
      persistDashboardUsers: persistDashboardUsers(cfgPath),
      persistAdminInvites: persistAdminInvites(cfgPath),
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

    const victor = await open();
    await victor.goto(`${base}/admin/ui`);
    await victor.fill("#username", "victor@example.com");
    await victor.fill("#password", "correct horse battery");
    await victor.click("#connect");
    await victor.waitForSelector("#app:not([hidden]) .tab[aria-selected=true]");
    await victor.click("#open-team");
    await victor.waitForSelector("#panel-team:not([hidden]) .mrow");
    assert.match(victor.url(), /tab=team/);
    assert.match(await victor.textContent("#team-count"), /1 dashboard login/);
    assert.match(
      await victor.locator("#team .mrow").first().textContent(),
      /victor@example\.com.*You/,
    );
    assert.equal(
      await victor
        .locator("#team .mrow")
        .first()
        .getByRole("button", { name: /More actions/ })
        .count(),
      1,
    );
    await victor
      .locator("#team .mrow")
      .first()
      .getByRole("button", { name: /More actions/ })
      .click();
    assert.equal(
      await victor.getByRole("menuitem", { name: "Remove login" }).count(),
      0,
      "the only login cannot be removed",
    );
    await victor.keyboard.press("Escape");

    await victor.click("#invite-admin");
    await victor.fill("#t-email", "Leo@Example.com");
    if (SHOTS)
      await victor.screenshot({
        path: `${SHOTS}/team-form-1280.png`,
        fullPage: true,
      });
    await victor.click("#t-save");
    await victor.waitForSelector("#team-link-panel:not([hidden])");
    const link = (await victor.textContent("#team-link-value"))!.trim();
    assert.match(link, new RegExp(`^${base}/admin/ui#invite=`));
    assert.match(
      await victor.locator("#team").textContent(),
      /leo@example\.com.*Invite pending/,
    );

    const leo = await open();
    await leo.goto(link);
    await leo.waitForSelector("#welcome:not([hidden])");
    await leo.fill("#new-password", "a long enough password");
    await leo.fill("#new-password2", "something different here");
    await leo.click("#welcome-save");
    assert.match(
      await leo.textContent("#welcome-error"),
      /two passwords are different/,
    );
    await leo.fill("#new-password2", "a long enough password");
    await leo.click("#welcome-save");
    await leo.waitForSelector("#app:not([hidden]) .tab[aria-selected=true]");
    assert.doesNotMatch(
      leo.url(),
      /invite=/,
      "the link is gone from the address bar once used",
    );
    assert.match(await leo.textContent("#who"), /leo@example\.com/);
    await leo.click("#open-team");
    await leo.waitForSelector("#team .mrow");
    assert.match(
      await leo
        .locator("#team .mrow", { hasText: "leo@example.com" })
        .textContent(),
      /You/,
    );
    if (SHOTS)
      await leo.screenshot({ path: `${SHOTS}/team-1280.png`, fullPage: true });

    await leo
      .locator("#team .mrow", { hasText: "victor@example.com" })
      .getByRole("button", { name: /More actions/ })
      .click();
    await leo.getByRole("menuitem", { name: "Remove login" }).click();
    assert.match(
      await leo.textContent("#confirm-body"),
      /victor@example\.com is signed out right away/,
    );
    await leo.click("#confirm-yes");
    await toast(leo, /Removed victor@example\.com/);
    await victor.reload();
    await victor.waitForSelector("#login:not([hidden])");

    assert.deepEqual(
      problems,
      [],
      "no script or security-policy errors on the page",
    );
  },
);
