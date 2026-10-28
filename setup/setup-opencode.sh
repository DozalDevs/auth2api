#!/bin/bash
#
# Connects OpenCode (the desktop app and the command line tool) on this Mac or Linux computer to the
# DozalDevs ChatGPT relay, using the personal API key you were given.
#
# Run it:       bash setup-opencode.sh
# Check later:  bash setup-opencode.sh --check     (changes nothing; proves your key and models work)
# Re-run it any time: it updates the setup in place (for example after you are given more models).
#
# What it changes, and nothing else:
#   ~/.config/opencode/opencode.json            adds a "dozaldevs-relay" provider (other settings are kept)
#   ~/.local/share/opencode/dozaldevs-relay.key your key, in a file only you can read
# The settings file is backed up next to the original before it is changed.

set -euo pipefail
umask 077

RELAY_URL_DEFAULT="__RELAY_URL__"
case "$RELAY_URL_DEFAULT" in __*) RELAY_URL_DEFAULT="https://dozaldevs-codex-relay-2.fly.dev" ;; esac
RELAY_URL="${RELAY_URL:-$RELAY_URL_DEFAULT}"
RELAY_URL="${RELAY_URL%/}"
PROVIDER_ID="dozaldevs-relay"
PROVIDER_NAME="DozalDevs ChatGPT Relay"
# Every model we know the relay can serve, cheapest first. We ask the relay which of these your key may use.
CANDIDATES="gpt-6-luna gpt-5.6-luna gpt-6-sol gpt-5.6-sol gpt-6.1-sol gpt-6.1-terra gpt-6-astra"

RELEASE_DATE="${RELAY_RELEASE_DATE:-$(date -u +%Y-%m-%d)}"
STALE_DAYS=150

CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
KEY_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/dozaldevs-relay.key"
STAMP="$(date +%Y%m%d-%H%M%S)"
CHECK=0

say() { printf '%s\n' "$*"; }
ok() { printf '[ok] %s\n' "$*"; }
warn() { printf '[!]  %s\n' "$*" >&2; }
die() {
  if [ "$CHECK" = 1 ]; then printf '\nCheck failed: %s\n' "$*" >&2; else printf '\nSetup stopped: %s\nNothing was changed.\n' "$*" >&2; fi
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    -h | --help)
      say "Connects OpenCode on this computer to the DozalDevs ChatGPT relay with your personal key."
      say "  bash setup-opencode.sh           set everything up (asks for your key)"
      say "  bash setup-opencode.sh --check   change nothing; prove your key and models work"
      exit 0
      ;;
    --check) CHECK=1 ;;
    *) printf 'Unknown option: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

OS="$(uname -s)"
case "$OS" in
  Darwin) command -v osascript >/dev/null 2>&1 || die "osascript is missing." ;;
  Linux) command -v python3 >/dev/null 2>&1 || die "python3 is needed to edit your settings. Install it with your package manager (for example: sudo apt install python3) and run this again." ;;
  MINGW* | MSYS* | CYGWIN*) die "this is the Mac and Linux script. On Windows, use the PowerShell script (setup-opencode.ps1)." ;;
  *) die "this script supports Mac and Linux, not $OS." ;;
esac
command -v curl >/dev/null 2>&1 || die "curl is missing."

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
HEADER_FILE="$TMP_DIR/header"
BODY_FILE="$TMP_DIR/body"

# ---- Settings editor. Mac: JavaScript for Automation (ships with macOS). Linux: python3. Same behaviour. ----
read -r -d '' EDITOR_JS <<'JS' || true
ObjC.import('Foundation');

function exists(p) { return $.NSFileManager.defaultManager.fileExistsAtPath($(p)); }
function readText(p) {
  var s = $.NSString.stringWithContentsOfFileEncodingError($(p), $.NSUTF8StringEncoding, null);
  if (s.isNil()) throw new Error('could not read ' + p);
  return ObjC.unwrap(s);
}
function writeText(p, text) {
  // Not atomic on purpose: writes through a symlink instead of replacing it.
  if (!$(text).writeToFileAtomicallyEncodingError($(p), false, $.NSUTF8StringEncoding, null)) {
    throw new Error('could not write ' + p);
  }
}
function loadObject(p) {
  if (!exists(p)) return { raw: null, obj: {} };
  var raw = readText(p);
  if (raw.trim() === '') return { raw: raw, obj: {} };
  var obj;
  try { obj = JSON.parse(raw); } catch (e) { throw new Error('UNPARSABLE ' + p); }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('UNPARSABLE ' + p);
  return { raw: raw, obj: obj };
}
function save(p, loaded, backup, obj) {
  var text = JSON.stringify(obj, null, 2) + '\n';
  if (loaded.raw === text) return 'unchanged';
  if (loaded.raw !== null) writeText(backup, loaded.raw);
  writeText(p, text);
  return loaded.raw === null ? 'created' : 'updated';
}
function prettyName(id) {
  var parts = id.split('-');
  var head = parts.slice(0, 2).join('-').toUpperCase();
  var rest = parts.slice(2).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); });
  return [head].concat(rest).join(' ');
}

function run(argv) {
  var op = argv[0];
  if (op === 'check') {
    loadObject(argv[1]);
    return 'ok';
  }
  if (op === 'age') {
    var found = loadObject(argv[1]).obj, rec = found.providers && found.providers[argv[2]];
    var first = rec && rec.models && Object.keys(rec.models).map(function (k) { return rec.models[k].releaseDate; }).filter(Boolean)[0];
    if (!first) return 'none';
    return String(Math.floor((Date.parse(argv[3]) - Date.parse(first)) / 86400000));
  }
  if (op === 'config') {
    var path = argv[1], id = argv[2], baseURL = argv[3], name = argv[4], allowed = argv[5].split(' '), backup = argv[6], keyFile = argv[7], releaseDate = argv[8];
    var loaded = loadObject(path);
    var cfg = loaded.obj;
    var models = {};
    allowed.forEach(function (m) { models[m] = { name: prettyName(m) }; });
    if (!cfg.provider || typeof cfg.provider !== 'object') cfg.provider = {};
    cfg.provider[id] = { npm: '@ai-sdk/openai-compatible', name: name, options: { baseURL: baseURL, apiKey: '{file:' + keyFile + '}' }, models: models };
    // OpenCode 2.x only lists a model in its picker when it looks recent and is the newest of its family,
    // so give each model a current release date and a family of its own. This block replaces the 2.x view of
    // the provider, so it has to carry the connection too, not just the models.
    var pm = {};
    allowed.forEach(function (m) { pm[m] = { name: prettyName(m), family: m, releaseDate: releaseDate }; });
    if (!cfg.providers || typeof cfg.providers !== 'object' || Array.isArray(cfg.providers)) cfg.providers = {};
    cfg.providers[id] = { name: name, package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: baseURL, apiKey: '{file:' + keyFile + '}' }, models: pm };
    var notes = [];
    var current = typeof cfg.model === 'string' ? cfg.model : '';
    var ours = current.indexOf(id + '/') === 0;
    if (!current || (ours && allowed.indexOf(current.slice(id.length + 1)) === -1)) {
      cfg.model = id + '/' + allowed[0];
    } else if (!ours) {
      notes.push('kept-model');
    }
    if (Array.isArray(cfg.enabled_providers) && cfg.enabled_providers.indexOf(id) === -1) cfg.enabled_providers.push(id);
    if (Array.isArray(cfg.disabled_providers) && cfg.disabled_providers.indexOf(id) !== -1) {
      cfg.disabled_providers = cfg.disabled_providers.filter(function (p) { return p !== id; });
    }
    if (!cfg.$schema) {
      var withSchema = { $schema: 'https://opencode.ai/config.json' };
      Object.keys(cfg).forEach(function (k) { withSchema[k] = cfg[k]; });
      cfg = withSchema;
    }
    return save(path, loaded, backup, cfg) + (notes.length ? ' ' + notes.join(' ') : '');
  }
  throw new Error('unknown operation');
}
JS

read -r -d '' EDITOR_PY <<'PY' || true
import json, os, sys


def pretty_name(i):
    parts = i.split('-')
    head = '-'.join(parts[:2]).upper()
    return ' '.join([head] + [w[:1].upper() + w[1:] for w in parts[2:]])


def load(p):
    if not os.path.exists(p):
        return None, {}
    with open(p, encoding='utf-8-sig') as f:
        raw = f.read()
    if raw.strip() == '':
        return raw, {}
    try:
        obj = json.loads(raw)
    except ValueError:
        sys.exit('UNPARSABLE ' + p)
    if not isinstance(obj, dict):
        sys.exit('UNPARSABLE ' + p)
    return raw, obj


def save(p, raw, backup, obj):
    text = json.dumps(obj, indent=2, ensure_ascii=False) + '\n'
    if raw == text:
        return 'unchanged'
    if raw is not None:
        with open(backup, 'w', encoding='utf-8', newline='\n') as f:
            f.write(raw)
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    return 'created' if raw is None else 'updated'


a = sys.argv[1:]
op = a[0]
if op == 'check':
    load(a[1])
    print('ok')
elif op == 'age':
    import datetime
    cfg = load(a[1])[1]
    rec = (cfg.get('providers') or {}).get(a[2]) if isinstance(cfg.get('providers'), dict) else None
    dates = [m.get('releaseDate') for m in ((rec or {}).get('models') or {}).values() if isinstance(m, dict) and m.get('releaseDate')]
    if not dates:
        print('none')
    else:
        d = lambda t: datetime.date.fromisoformat(t[:10])
        print((d(a[3]) - d(dates[0])).days)
elif op == 'config':
    path, pid, base, name, allowed, backup, key_file, release_date = a[1], a[2], a[3], a[4], a[5].split(' '), a[6], a[7], a[8]
    raw, cfg = load(path)
    models = {m: {'name': pretty_name(m)} for m in allowed}
    if not isinstance(cfg.get('provider'), dict):
        cfg['provider'] = {}
    cfg['provider'][pid] = {
        'npm': '@ai-sdk/openai-compatible',
        'name': name,
        'options': {'baseURL': base, 'apiKey': '{file:' + key_file + '}'},
        'models': models,
    }
    if not isinstance(cfg.get('providers'), dict):
        cfg['providers'] = {}
    cfg['providers'][pid] = {'name': name, 'package': '@opencode/ai/providers/openai-compatible', 'settings': {'baseURL': base, 'apiKey': '{file:' + key_file + '}'}, 'models': {m: {'name': pretty_name(m), 'family': m, 'releaseDate': release_date} for m in allowed}}
    notes = []
    current = cfg['model'] if isinstance(cfg.get('model'), str) else ''
    ours = current.startswith(pid + '/')
    if not current or (ours and current[len(pid) + 1:] not in allowed):
        cfg['model'] = pid + '/' + allowed[0]
    elif not ours:
        notes.append('kept-model')
    if isinstance(cfg.get('enabled_providers'), list) and pid not in cfg['enabled_providers']:
        cfg['enabled_providers'].append(pid)
    if isinstance(cfg.get('disabled_providers'), list) and pid in cfg['disabled_providers']:
        cfg['disabled_providers'] = [p for p in cfg['disabled_providers'] if p != pid]
    if not cfg.get('$schema'):
        cfg = dict([('$schema', 'https://opencode.ai/config.json')] + [(k, v) for k, v in cfg.items() if k != '$schema'])
    print(' '.join([save(path, raw, backup, cfg)] + notes))
else:
    sys.exit('unknown operation')
PY

run_editor() {
  local out
  if [ "$OS" = "Darwin" ]; then
    out="$(osascript -l JavaScript -e "$EDITOR_JS" "$@" 2>&1)" || out="FAILED $out"
  else
    out="$(python3 -c "$EDITOR_PY" "$@" 2>&1)" || out="FAILED $out"
  fi
  case "$out" in
    FAILED*UNPARSABLE*) die "$(printf '%s' "$out" | sed -n 's/.*UNPARSABLE \(.*\)$/\1/p' | sed 's/ (-[0-9]*)$//' | head -1) is not plain JSON (it may have comments in it), so I did not touch it. Ask the engineering team for help." ;;
    FAILED*) die "could not update your OpenCode settings: ${out#FAILED }" ;;
  esac
  printf '%s' "$out"
}

# ---- 1. Get the key (never put it on a command line, where other programs could read it) ----
if [ "$CHECK" = 1 ]; then
  [ -f "$KEY_FILE" ] || die "no saved key at $KEY_FILE. Run the setup first (without --check)."
  KEY="$(cat "$KEY_FILE")"
else
  KEY="${RELAY_API_KEY:-}"
  if [ -z "$KEY" ]; then
    [ -r /dev/tty ] || die "no terminal to ask for your key. Run this in a Terminal window, or set RELAY_API_KEY."
    printf 'Paste your relay API key (nothing shows as you type), then press Return: ' >&2
    IFS= read -rs KEY </dev/tty || true
    printf '\n' >&2
  fi
fi
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
[ -n "$KEY" ] || die "no key entered."
[ "${#KEY}" -ge 16 ] || die "that does not look like a full key (too short). Copy the whole thing."
printf 'Authorization: Bearer %s\n' "$KEY" >"$HEADER_FILE"

# curl_relay METHOD PATH [JSON_BODY] -> prints the HTTP status, leaves the response in $BODY_FILE
curl_relay() {
  local method="$1" path="$2" data="${3:-}" status
  if [ -n "$data" ]; then
    status="$(curl -sS --max-time 90 -o "$BODY_FILE" -w '%{http_code}' -X "$method" -H "@$HEADER_FILE" \
      -H 'Content-Type: application/json' -d "$data" "$RELAY_URL$path" 2>/dev/null || true)"
  else
    status="$(curl -sS --max-time 30 -o "$BODY_FILE" -w '%{http_code}' -X "$method" -H "@$HEADER_FILE" \
      "$RELAY_URL$path" 2>/dev/null || true)"
  fi
  printf '%s' "${status:-000}"
}
relay_message() { sed -n 's/.*"message":"\([^"]*\)".*/\1/p' "$BODY_FILE" | head -1; }

# ---- 2. Make sure we can safely edit the settings file before talking to the relay ----
if [ "$CHECK" = 0 ]; then run_editor check "$CONFIG_FILE" >/dev/null; fi

# ---- 3. Check the key works ----
say "Checking your key with the relay..."
code="$(curl_relay GET /v1/models)"
case "$code" in
  200) ok "The relay accepted your key." ;;
  000) die "could not reach $RELAY_URL. Check your internet connection and try again." ;;
  401 | 403) die "the relay rejected your key ($(relay_message)). Ask the engineering team for a new one, and make sure you copied all of it." ;;
  *) die "the relay answered with an unexpected error (HTTP $code). Try again in a minute." ;;
esac

# ---- 4. Find out which models this key may use ----
say "Finding the models your key can use (this takes a few seconds)..."
ALLOWED=""
for model in $CANDIDATES; do
  payload="{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: ok\"}]}"
  code="$(curl_relay POST /v1/chat/completions "$payload")"
  case "$code" in
    200 | 429)
      # 429 means the key is allowed to use the model but is at its daily limit right now.
      ALLOWED="$ALLOWED $model"
      if [ "$code" = "429" ]; then warn "$model: your daily limit is used up for today; it will work again after midnight UTC."; else ok "$model"; fi
      ;;
    403)
      if grep -q 'model_not_allowed' "$BODY_FILE"; then
        say "     $model: not enabled for your key (skipped)"
      else
        die "the relay rejected your key ($(relay_message))."
      fi
      ;;
    000) die "lost the connection to the relay while testing models. Try again." ;;
    *) say "     $model: not available right now (skipped)" ;;
  esac
done
ALLOWED="${ALLOWED# }"
[ -n "$ALLOWED" ] || die "your key is not allowed to use any model yet. Ask the engineering team to enable one."
DEFAULT_MODEL="${ALLOWED%% *}"

# ---- Check mode stops here: confirm the settings point at the key, change nothing ----
if [ "$CHECK" = 1 ]; then
  [ -f "$CONFIG_FILE" ] || die "no OpenCode settings at $CONFIG_FILE. Run the setup first (without --check)."
  grep -q "\"$PROVIDER_ID\"" "$CONFIG_FILE" || die "OpenCode is not set up for the relay yet. Run the setup first (without --check)."
  grep -qF "{file:$KEY_FILE}" "$CONFIG_FILE" || die "OpenCode's settings do not point at your saved key. Run the setup again (without --check)."
  ok "OpenCode's settings point at your saved key."
  age="$(run_editor age "$CONFIG_FILE" "$PROVIDER_ID" "$RELEASE_DATE")"
  case "$age" in
    none) die "OpenCode's model menu entries are out of date. Run the setup again (without --check)." ;;
    *[!0-9-]*) die "could not read the model menu dates in $CONFIG_FILE." ;;
  esac
  if [ "$age" -gt "$STALE_DAYS" ]; then
    die "the relay's models will drop out of OpenCode's model menu soon (set up $age days ago). Run the setup again (without --check) to refresh them."
  fi
  ok "The relay's models are set to show in OpenCode's model menu."
  say ""
  say "Check passed. Models you can use: $ALLOWED"
  exit 0
fi

# ---- 5. Save the key (private file) and write the settings ----
mkdir -p "$(dirname "$CONFIG_FILE")" "$(dirname "$KEY_FILE")"
if [ -f "$KEY_FILE" ] && [ "$(cat "$KEY_FILE")" = "$KEY" ]; then
  key_result="unchanged"
else
  [ -f "$KEY_FILE" ] && key_result="updated" || key_result="created"
  printf '%s' "$KEY" >"$KEY_FILE"
fi
chmod 600 "$KEY_FILE"

config_result="$(run_editor config "$CONFIG_FILE" "$PROVIDER_ID" "$RELAY_URL/v1" "$PROVIDER_NAME" "$ALLOWED" "$CONFIG_FILE.bak-$STAMP" "$KEY_FILE" "$RELEASE_DATE")"

ok "OpenCode settings: ${config_result%% *} ($CONFIG_FILE)"
ok "Your key: $key_result (private file $KEY_FILE)"
case "$config_result" in *kept-model*) say "     Your existing default model was left as it was; pick the relay's models from the model menu." ;; esac

# ---- 6. Tell them what to do next ----
say ""
say "All set. Models you can use: $ALLOWED"
say "Default model: $PROVIDER_ID/$DEFAULT_MODEL"
say ""
APP_FOUND=""
if [ "$OS" = "Darwin" ]; then
  for app in /Applications/OpenCode.app "$HOME/Applications/OpenCode.app"; do [ -d "$app" ] && APP_FOUND="$app"; done
  if [ -z "$APP_FOUND" ]; then
    warn "The OpenCode desktop app is not in your Applications folder yet."
    say "     Download it from https://opencode.ai/download (open the .dmg, drag OpenCode into Applications),"
    say "     then open it. It will already be connected."
  elif pgrep -x OpenCode >/dev/null 2>&1; then
    say "OpenCode is open right now. Quit it completely (Cmd+Q) and open it again to pick up the change."
  else
    say "Open the OpenCode app and start chatting. It is already connected."
  fi
else
  say "Start (or restart) OpenCode and pick a $PROVIDER_ID model. It is already connected."
fi
say "To double-check later, run this script again with --check. If something does not work, send the engineering team what it prints (it never prints your key)."
