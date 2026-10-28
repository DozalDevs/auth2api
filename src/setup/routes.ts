import express from "express";
import fs from "fs";
import path from "path";

const SETUP_DIR = path.resolve(__dirname, "..", "..", "setup");
const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

const FILES: Record<string, string> = {
  "/setup/opencode.sh": "setup-opencode.sh",
  "/setup/opencode.ps1": "setup-opencode.ps1",
  "/setup/prompt.txt": "agent-prompt.txt",
};

export function relayOrigin(req: express.Request): string | undefined {
  const host = req.headers.host;
  if (typeof host !== "string" || !HOST_RE.test(host)) return undefined;
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  return `${secure ? "https" : "http"}://${host}`;
}

export function registerSetupRoutes(app: express.Application): void {
  for (const [route, file] of Object.entries(FILES)) {
    app.get(route, (req, res) => {
      const origin = relayOrigin(req);
      if (!origin) {
        res.status(400).type("text").send("Bad Host header\n");
        return;
      }
      let body: string;
      try {
        body = fs.readFileSync(path.join(SETUP_DIR, file), "utf-8");
      } catch {
        res.status(404).type("text").send("Not found\n");
        return;
      }
      res
        .set({
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .type("text/plain; charset=utf-8")
        .send(body.split("__RELAY_URL__").join(origin));
    });
  }
}
