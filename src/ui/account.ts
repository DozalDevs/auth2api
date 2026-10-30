import crypto from "crypto";
import { ACCOUNT_JS } from "./account-client";
import { ACCOUNT_BODY } from "./account-markup";
import { ACCOUNT_CSS, CSS } from "./styles";

const STYLE = CSS + ACCOUNT_CSS;

function sha256(s: string): string {
  return `'sha256-${crypto.createHash("sha256").update(s).digest("base64")}'`;
}

export const ACCOUNT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>DozalDevs AI Relay: your access</title>
<style>${STYLE}</style>
</head>
<body>${ACCOUNT_BODY}<script>${ACCOUNT_JS}</script>
</body>
</html>
`;

export const ACCOUNT_CSP = [
  "default-src 'none'",
  `script-src ${sha256(ACCOUNT_JS)}`,
  `style-src ${sha256(STYLE)}`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
