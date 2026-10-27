import crypto from "crypto";

const CSS = String.raw`
:root {
  --bg: #f6f7f9; --panel: #fff; --text: #14181f; --muted: #5b6573; --line: #dfe3e9;
  --accent: #1f5fd1; --accent-text: #fff; --danger: #b42318; --warn: #b54708; --ok: #17794a;
  --chip: #eef1f5; --bar: #e6e9ee; --focus: #1f5fd1;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --panel: #171b21; --text: #e8ebf0; --muted: #9aa5b4; --line: #2a313b;
    --accent: #6ea0ff; --accent-text: #0b1220; --danger: #ff8a80; --warn: #f5b361; --ok: #5fd39b;
    --chip: #222831; --bar: #2a313b; --focus: #6ea0ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 16px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 16px; margin: 0; }
button, input { font: inherit; color: inherit; }
button { min-height: 40px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); cursor: pointer; }
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
button.danger { color: var(--danger); }
button:disabled { opacity: .55; cursor: not-allowed; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
input[type=text], input[type=password], input[type=number] { width: 100%; min-height: 40px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
label { display: block; font-weight: 600; margin-bottom: 4px; }
.hint { color: var(--muted); font-size: 13px; margin: 4px 0 0; }
.muted { color: var(--muted); }
header.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
header.top .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
#status { min-height: 22px; margin-bottom: 12px; font-weight: 600; }
#status.error { color: var(--danger); }
#status.ok { color: var(--ok); }
.login { max-width: 420px; margin: 12vh auto 0; }
.login .panel { padding: 24px; }
.login h1 { margin-bottom: 16px; }
.login form > * + * { margin-top: 12px; }
.krow { display: grid; grid-template-columns: 1.1fr 1.5fr 1.4fr 1fr 232px; gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); }
.krow.head { border-top: 0; padding-top: 0; color: var(--muted); font-size: 13px; font-weight: 600; }
.krow .name { font-weight: 600; overflow-wrap: anywhere; }
.krow .suffix { color: var(--muted); font-size: 13px; font-weight: 400; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { background: var(--chip); border-radius: 999px; padding: 2px 10px; font-size: 13px; overflow-wrap: anywhere; }
.badge { display: inline-block; width: fit-content; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 700; border: 1px solid var(--line); }
.badge.active { color: var(--ok); border-color: var(--ok); }
.badge.disabled { color: var(--muted); }
.badge.admin { color: var(--accent); border-color: var(--accent); margin-left: 4px; }
.meter { height: 6px; background: var(--bar); border-radius: 999px; overflow: hidden; margin-top: 4px; }
.meter > span { display: block; height: 100%; background: var(--ok); }
.meter.warn > span { background: var(--warn); }
.meter.over > span { background: var(--danger); }
.row-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.row-actions button { min-height: 36px; padding: 0 10px; }
.form-grid { display: grid; gap: 16px; }
.models { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 16px; }
.models label { font-weight: 400; display: flex; align-items: center; gap: 8px; margin: 0; min-height: 32px; overflow-wrap: anywhere; }
.inline { display: flex; gap: 8px; }
.inline button { white-space: nowrap; }
.form-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.secret { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; word-break: break-all; background: var(--chip); border: 1px solid var(--line); border-radius: 8px; padding: 12px; user-select: all; }
.callout { border-left: 4px solid var(--warn); padding: 8px 12px; background: var(--chip); border-radius: 4px; margin: 12px 0; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; min-height: 36px; }
.seg button[aria-pressed=true] { background: var(--accent); color: var(--accent-text); font-weight: 600; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 560px; }
th, td { text-align: left; padding: 8px 10px; border-top: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-size: 13px; font-weight: 600; border-top: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.srow { display: grid; grid-template-columns: 1.5fr 1fr 1fr; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
.srow.head { border-top: 0; color: var(--muted); font-size: 13px; font-weight: 600; }
.srow .num { text-align: right; font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); padding: 16px 0 4px; }
h3 { font-size: 14px; margin: 16px 0 4px; color: var(--muted); }
[hidden] { display: none !important; }
.err { color: var(--danger); }
.flat { margin: 0 0 12px; }
.mb { margin-bottom: 12px; }
.mt { margin-top: 12px; }
.mt-s { margin-top: 6px; }
.mt-m { margin-top: 8px; }
.anyrow { font-weight: 400; display: flex; gap: 8px; align-items: center; }
@media (max-width: 760px) {
  main { padding: 12px; }
  .krow.head { display: none; }
  .krow { grid-template-columns: 1fr; gap: 8px; padding: 16px 0; }
  .row-actions { justify-content: stretch; }
  .row-actions button { flex: 1; min-height: 44px; }
  button { min-height: 44px; }
  .form-actions button, .login button { flex: 1; }
  .inline { flex-direction: column; }
}
`;

const JS = String.raw`
(function () {
  'use strict';
  var state = { keys: [], usage: null, days: 1, editing: null };

  function $(id) { return document.getElementById(id); }
  function h(tag, props, kids) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'text') node.textContent = props[k];
      else if (k === 'class') node.className = props[k];
      else if (k === 'style') node.style.cssText = props[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== false && props[k] !== null && props[k] !== undefined) node.setAttribute(k, props[k] === true ? '' : props[k]);
    });
    (kids || []).forEach(function (kid) { if (kid) node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid); });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function full(n) { return Number(n).toLocaleString('en-US'); }
  function short(n) {
    n = Number(n);
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  var statusTimer = null;
  function say(msg, kind) {
    var el = $('status');
    el.textContent = msg || '';
    el.className = kind || '';
    clearTimeout(statusTimer);
    if (msg && kind !== 'error') statusTimer = setTimeout(function () { say(''); }, 5000);
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { 'X-Relay-Csrf': '1' } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.error && data.error.message) || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function showLogin(message) {
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = message || '';
    $('password').value = '';
    $('username').focus();
  }
  function signOut() {
    api('POST', '/admin/ui/logout').catch(function () {}).then(function () { showLogin(''); });
  }
  function fail(err) {
    if (err.status === 401) { showLogin('Your session ended. Sign in again.'); return; }
    say(err.message, 'error');
  }

  function usedToday(k) { return k.tokens_today === null ? null : k.tokens_today; }

  function renderKeys() {
    var list = $('keys');
    clear(list);
    $('key-count').textContent = state.keys.length ? '(' + state.keys.length + ')' : '';
    if (!state.keys.length) { list.appendChild(h('p', { class: 'empty', text: 'No keys yet. Add one to give someone access.' })); return; }
    list.appendChild(h('div', { class: 'krow head', 'aria-hidden': 'true' }, [
      h('div', { text: 'Name' }), h('div', { text: 'Models' }), h('div', { text: 'Tokens today' }), h('div', { text: 'Status' }), h('div', { text: '' })
    ]));
    state.keys.forEach(function (k) {
      var used = usedToday(k);
      var meter = null;
      var usage;
      if (used === null) usage = h('div', { class: 'muted', text: 'Not tracked' });
      else if (k.daily_token_limit) {
        var pct = Math.min(100, Math.round(used / k.daily_token_limit * 100));
        var cls = 'meter' + (used >= k.daily_token_limit ? ' over' : pct >= 80 ? ' warn' : '');
        meter = h('div', { class: cls, role: 'img', 'aria-label': pct + ' percent of the daily limit used' }, [h('span', { style: 'width:' + pct + '%' })]);
        usage = h('div', {}, [h('div', { title: full(used) + ' of ' + full(k.daily_token_limit), text: short(used) + ' of ' + short(k.daily_token_limit) + ' today' }), meter]);
      } else usage = h('div', {}, [h('div', { title: full(used), text: short(used) + ' today \u00b7 no cap' })]);

      var chips = h('div', { class: 'chips' }, k.models.map(function (m) { return h('span', { class: 'chip', text: m === '*' ? 'Any model' : m }); }));
      var status = h('div', {}, [
        h('span', { class: 'badge ' + (k.disabled ? 'disabled' : 'active'), text: k.disabled ? 'Disabled' : 'Active' }),
        k.admin ? h('span', { class: 'badge admin', text: 'Admin' }) : null
      ]);
      var actions = h('div', { class: 'row-actions' }, [
        h('button', { type: 'button', text: 'Edit', onclick: function () { openForm(k); } }),
        h('button', { type: 'button', text: k.disabled ? 'Enable' : 'Disable', onclick: function () { toggle(k); } }),
        h('button', { type: 'button', class: 'danger', text: 'Delete', onclick: function () { remove(k); } })
      ]);
      list.appendChild(h('div', { class: 'krow' }, [
        h('div', { class: 'name' }, [k.name, h('div', { class: 'suffix', text: 'key ends in ' + k.key_suffix })]),
        chips, usage, status, actions
      ]));
    });
  }

  function discoveredModels(extra) {
    var seen = {};
    var out = [];
    function add(m) { if (m && m !== '*' && m !== 'unknown' && !seen[m]) { seen[m] = true; out.push(m); } }
    state.keys.forEach(function (k) { k.models.forEach(add); });
    if (state.usage) state.usage.rows.forEach(function (r) { add(r.model); });
    (extra || []).forEach(add);
    return out.sort();
  }

  function openForm(key) {
    state.editing = key || null;
    var form = $('key-form');
    $('form-title').textContent = key ? 'Edit ' + key.name : 'Add a key';
    $('f-name').value = key ? key.name : '';
    $('f-name').disabled = !!key;
    $('f-cap').value = key && key.daily_token_limit ? key.daily_token_limit : '';
    $('f-any').checked = !!key && key.models.indexOf('*') !== -1;
    renderModelBoxes(key ? key.models.filter(function (m) { return m !== '*'; }) : []);
    $('f-save').textContent = key ? 'Save changes' : 'Create key';
    $('secret-panel').hidden = true;
    form.hidden = false;
    syncAny();
    (key ? $('f-cap') : $('f-name')).focus();
    form.scrollIntoView({ block: 'nearest' });
  }
  function closeForm() { $('key-form').hidden = true; state.editing = null; }

  function renderModelBoxes(selected) {
    var box = $('f-models');
    clear(box);
    discoveredModels(selected).forEach(function (m) {
      var cb = h('input', { type: 'checkbox', value: m });
      cb.checked = selected.indexOf(m) !== -1;
      box.appendChild(h('label', {}, [cb, m]));
    });
    if (!box.firstChild) box.appendChild(h('p', { class: 'hint', text: 'No models seen yet. Add one below.' }));
  }
  function syncAny() {
    var any = $('f-any').checked;
    Array.prototype.forEach.call($('f-models').querySelectorAll('input'), function (cb) { cb.disabled = any; });
    $('f-other').disabled = any;
    $('f-other-add').disabled = any;
  }
  function selectedModels() {
    if ($('f-any').checked) return ['*'];
    return Array.prototype.filter.call($('f-models').querySelectorAll('input'), function (cb) { return cb.checked; }).map(function (cb) { return cb.value; });
  }
  function addOtherModel() {
    var name = $('f-other').value.trim();
    if (!name) return;
    var current = selectedModels();
    if (current.indexOf(name) === -1) current.push(name);
    renderModelBoxes(current);
    $('f-other').value = '';
    syncAny();
  }

  function submitForm(ev) {
    ev.preventDefault();
    var models = selectedModels();
    if (!models.length) { say('Pick at least one model, or choose Any model.', 'error'); return; }
    var capText = $('f-cap').value.trim();
    var cap = capText === '' ? null : Number(capText);
    if (cap !== null && (!Number.isInteger(cap) || cap <= 0)) { say('The daily limit must be a whole number above zero, or left empty.', 'error'); return; }
    var save = $('f-save');
    save.disabled = true;
    var req;
    if (state.editing) req = api('PATCH', '/admin/keys/' + encodeURIComponent(state.editing.name), { models: models, daily_token_limit: cap });
    else {
      var body = { name: $('f-name').value.trim(), models: models };
      if (cap !== null) body.daily_token_limit = cap;
      req = api('POST', '/admin/keys', body);
    }
    req.then(function (res) {
      var created = !state.editing;
      closeForm();
      if (created) showSecret(res);
      say(created ? 'Key ' + res.name + ' created.' : 'Saved.', 'ok');
      return refresh();
    }).catch(fail).then(function () { save.disabled = false; });
  }

  function showSecret(res) {
    $('secret-name').textContent = res.name;
    $('secret-value').textContent = res.key;
    $('copy-btn').textContent = 'Copy key';
    $('secret-panel').hidden = false;
    $('secret-panel').scrollIntoView({ block: 'nearest' });
  }
  function copySecret() {
    var text = $('secret-value').textContent;
    var done = function () { $('copy-btn').textContent = 'Copied'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, selectSecret);
    else selectSecret();
  }
  function selectSecret() {
    var range = document.createRange();
    range.selectNodeContents($('secret-value'));
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    say('Press Ctrl+C or Cmd+C to copy the selected key.', 'ok');
  }
  function hideSecret() { $('secret-value').textContent = ''; $('secret-panel').hidden = true; }

  function toggle(k) {
    api('PATCH', '/admin/keys/' + encodeURIComponent(k.name), { disabled: !k.disabled })
      .then(function () { say((k.disabled ? 'Enabled ' : 'Disabled ') + k.name + '.', 'ok'); return refresh(); }).catch(fail);
  }
  function remove(k) {
    if (!window.confirm('Delete ' + k.name + '? Anyone using this key loses access right away. This cannot be undone.')) return;
    api('DELETE', '/admin/keys/' + encodeURIComponent(k.name))
      .then(function () { say('Deleted ' + k.name + '.', 'ok'); return refresh(); }).catch(fail);
  }

  function renderUsage() {
    var u = state.usage;
    var people = $('by-person');
    var details = $('details');
    clear(people); clear(details);
    if (!u || !u.rows.length) {
      people.appendChild(h('p', { class: 'empty', text: 'No usage recorded in this period.' }));
      return;
    }
    people.appendChild(h('div', { class: 'srow head' }, [h('div', { text: 'Person' }), h('div', { class: 'num', text: 'Requests' }), h('div', { class: 'num', text: 'Tokens' })]));
    u.by_key.slice().sort(function (a, b) { return b.tokens - a.tokens; }).forEach(function (r) {
      people.appendChild(h('div', { class: 'srow' }, [h('div', { text: r.name, class: 'name' }), h('div', { class: 'num', text: full(r.requests) }), h('div', { class: 'num', title: full(r.tokens), text: short(r.tokens) })]));
    });
    var head = h('tr', {}, [h('th', { text: 'Day' }), h('th', { text: 'Person' }), h('th', { text: 'Model' }), h('th', { class: 'num', text: 'Requests' }), h('th', { class: 'num', text: 'Failed' }), h('th', { class: 'num', text: 'Input' }), h('th', { class: 'num', text: 'Output' })]);
    var body = u.rows.map(function (r) {
      return h('tr', {}, [h('td', { text: r.day }), h('td', { text: r.name }), h('td', { text: r.model }), h('td', { class: 'num', text: full(r.requests) }), h('td', { class: 'num', text: full(r.failures) }), h('td', { class: 'num', text: full(r.inputTokens) }), h('td', { class: 'num', text: full(r.outputTokens) })]);
    });
    details.appendChild(h('table', {}, [h('thead', {}, [head]), h('tbody', {}, body)]));
  }

  function setDays(n) {
    state.days = n;
    Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) { b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-days')) === n)); });
    refresh();
  }

  function refresh() {
    $('refresh').disabled = true;
    return Promise.all([api('GET', '/admin/keys'), api('GET', '/admin/usage?days=' + state.days)]).then(function (res) {
      state.keys = res[0].keys;
      state.usage = res[1];
      renderKeys();
      renderUsage();
      $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
      $('loading').hidden = true;
    }).catch(function (err) { $('loading').hidden = true; fail(err); }).then(function () { $('refresh').disabled = false; });
  }

  function enter(username) {
    $('password').value = '';
    $('login').hidden = true;
    $('app').hidden = false;
    $('loading').hidden = false;
    $('host').textContent = 'Signed in as ' + username + ' \u00b7 ' + location.host;
    refresh();
  }

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var username = $('username').value.trim();
    var password = $('password').value;
    if (!username || !password) return;
    $('login-error').textContent = '';
    $('connect').disabled = true;
    api('POST', '/admin/ui/login', { username: username, password: password })
      .then(function (res) { enter(res.username); })
      .catch(function (err) { $('login-error').textContent = err.message; $('password').value = ''; })
      .then(function () { $('connect').disabled = false; });
  });
  $('signout').addEventListener('click', signOut);
  $('refresh').addEventListener('click', function () { refresh(); });
  $('add-key').addEventListener('click', function () { openForm(null); });
  $('f-cancel').addEventListener('click', closeForm);
  $('key-form').addEventListener('submit', submitForm);
  $('f-any').addEventListener('change', syncAny);
  $('f-other-add').addEventListener('click', addOtherModel);
  $('f-other').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); addOtherModel(); } });
  $('copy-btn').addEventListener('click', copySecret);
  $('secret-done').addEventListener('click', hideSecret);
  Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
    b.addEventListener('click', function () { setDays(Number(b.getAttribute('data-days'))); });
  });

  api('GET', '/admin/ui/session').then(function (res) { enter(res.username); }).catch(function () { showLogin(''); });
})();
`;

const BODY = String.raw`
<main>
  <section id="login" class="login" hidden>
    <div class="panel">
      <h1>Relay admin</h1>
      <form id="login-form">
        <div>
          <label for="username">Username</label>
          <input id="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required>
        </div>
        <div>
          <label for="password">Password</label>
          <input id="password" type="password" autocomplete="current-password" required>
        </div>
        <p id="login-error" class="hint err" role="alert"></p>
        <button id="connect" class="primary" type="submit">Sign in</button>
      </form>
    </div>
  </section>

  <div id="app" hidden>
    <header class="top">
      <div>
        <h1>Relay keys</h1>
        <div class="muted"><span id="host"></span> &middot; <span id="updated"></span></div>
      </div>
      <div class="actions">
        <button id="refresh" type="button">Refresh</button>
        <button id="signout" type="button">Sign out</button>
      </div>
    </header>

    <div id="status" role="status" aria-live="polite"></div>

    <section id="secret-panel" class="panel" hidden>
      <h2>Key created for <span id="secret-name"></span></h2>
      <div class="callout">This is the only time the full key is shown. Copy it now and send it to them privately.</div>
      <div id="secret-value" class="secret"></div>
      <div class="form-actions mt">
        <button id="copy-btn" class="primary" type="button">Copy key</button>
        <button id="secret-done" type="button">Done</button>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Keys <span id="key-count" class="muted"></span></h2>
        <button id="add-key" class="primary" type="button">Add key</button>
      </div>

      <form id="key-form" hidden>
        <div class="panel flat">
          <h2 id="form-title" class="mb"></h2>
          <div class="form-grid">
            <div>
              <label for="f-name">Name</label>
              <input id="f-name" type="text" required maxlength="63" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" placeholder="maria" autocomplete="off">
              <p class="hint">Letters, numbers, dot, dash or underscore. Reports show this name.</p>
            </div>
            <div>
              <label>Models this key can use</label>
              <label class="anyrow"><input id="f-any" type="checkbox"> Any model</label>
              <div id="f-models" class="models mt-s"></div>
              <div class="inline mt-m">
                <input id="f-other" type="text" placeholder="Another model name" aria-label="Another model name" autocomplete="off">
                <button id="f-other-add" type="button">Add model</button>
              </div>
            </div>
            <div>
              <label for="f-cap">Daily token limit</label>
              <input id="f-cap" type="number" min="1" step="1" inputmode="numeric" placeholder="No limit">
              <p class="hint">Input plus output tokens per UTC day. Soft: a call already running can go a little over.</p>
            </div>
            <div class="form-actions">
              <button id="f-save" class="primary" type="submit">Create key</button>
              <button id="f-cancel" type="button">Cancel</button>
            </div>
          </div>
        </div>
      </form>

      <p id="loading" class="empty">Loading keys&hellip;</p>
      <div id="keys"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Usage</h2>
        <div class="seg" role="group" aria-label="Period">
          <button type="button" data-days="1" aria-pressed="true">Today</button>
          <button type="button" data-days="7" aria-pressed="false">7 days</button>
          <button type="button" data-days="30" aria-pressed="false">30 days</button>
        </div>
      </div>
      <div id="by-person"></div>
      <h3>By day and model</h3>
      <div id="details" class="scroll"></div>
    </section>
  </div>
</main>
`;

function sha256(s: string): string {
  return `'sha256-${crypto.createHash("sha256").update(s).digest("base64")}'`;
}

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Relay admin</title>
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
