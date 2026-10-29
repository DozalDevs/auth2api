import crypto from "crypto";
import { JS } from "./client";
import { BODY } from "./markup";
import { CSS } from "./styles";

function sha256(s: string): string {
  return `'sha256-${crypto.createHash("sha256").update(s).digest("base64")}'`;
}

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>DozalDevs AI Relay</title>
<style>${CSS}</style>
</head>
<body>${BODY}<script>${JS}</script>
</body>
</html>
`;

export const DASHBOARD_CSP = [
  "default-src 'none'",
  `script-src ${sha256(JS)}`,
  `style-src ${sha256(CSS)}`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
