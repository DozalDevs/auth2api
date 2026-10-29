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
.krow { display: grid; grid-template-columns: 1.1fr 1.7fr 1.3fr .9fr 330px; gap: 12px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); }
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
.ms { position: relative; }
.ms-btn { width: 100%; min-height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; padding: 0 10px; }
.ms-btn[aria-expanded=true] { border-color: var(--accent); }
.ms-caret { color: var(--muted); }
.ms-panel { margin-top: 6px; max-height: 340px; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px; }
.ms-search { margin-bottom: 6px; }
.ms-row { font-weight: 400; display: flex; align-items: center; gap: 10px; margin: 0; min-height: 40px; padding: 0 8px; border-radius: 6px; cursor: pointer; }
.ms-row:hover { background: var(--chip); }
.ms-row input { flex: none; }
.ms-name { flex: 1; overflow-wrap: anywhere; }
.ms-id { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.ms-any { border-bottom: 1px solid var(--line); border-radius: 6px 6px 0 0; margin-bottom: 4px; font-weight: 600; }
.ms-empty { color: var(--muted); padding: 8px; }
.ms-foot { display: flex; justify-content: space-between; gap: 8px; padding-top: 8px; margin-top: 4px; border-top: 1px solid var(--line); }
.ms-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.chip-x { min-height: 0; height: 18px; width: 18px; padding: 0; margin-left: 4px; border: 0; background: transparent; color: var(--muted); line-height: 1; border-radius: 999px; }
.chip-x:hover { color: var(--danger); }
.pills { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.pill { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; border: 1px solid var(--accent); color: var(--text); border-radius: 8px; padding: 3px 8px; }
.pill .left { color: var(--accent); font-weight: 700; white-space: nowrap; }
.pill.ended { border-color: var(--line); color: var(--muted); }
.pill button { min-height: 24px; padding: 0 8px; font-size: 12px; margin-left: auto; }
.dur { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dur .seg { flex-wrap: wrap; }
.dur-custom { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.dur-custom input { width: 110px; }
.dur-custom select { min-height: 40px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 0 8px; font: inherit; color: inherit; }
.preview { margin-top: 8px; font-weight: 600; color: var(--accent); }
.mrow { display: grid; grid-template-columns: 1.3fr 1.3fr 1.6fr 110px; gap: 12px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
.mrow.head { border-top: 0; padding-top: 0; color: var(--muted); font-size: 13px; font-weight: 600; }
.mrow select { min-height: 40px; width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 0 8px; font: inherit; color: inherit; }
.madd { display: grid; grid-template-columns: 1.3fr 1.3fr 1.6fr 110px; gap: 12px; align-items: end; margin-top: 12px; }
.madd label { margin-bottom: 4px; }
.madd button { white-space: nowrap; }
.madd select { min-height: 40px; width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 0 8px; font: inherit; color: inherit; }
.krow-grid-extra { grid-column: 1 / -1; }
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

@media (max-width: 760px) {
  .ms-panel { max-height: 60vh; }
  .ms-row { min-height: 44px; }
  .mrow.head { display: none; }
  .mrow { grid-template-columns: 1fr; gap: 8px; padding: 14px 0; }
  .madd { grid-template-columns: 1fr; }
  .pill button { min-height: 36px; }
  .dur .seg button { flex: 1; }
}
`;

const JS = String.raw`
(function () {
  'use strict';
  var state = { keys: [], usage: null, models: [], modelSource: 'default', days: 1, editing: null, granting: null, go: null };
  var PRESETS = [{ label: '2 hours', minutes: 120 }, { label: '4 hours', minutes: 240 }, { label: '8 hours', minutes: 480 }, { label: '24 hours', minutes: 1440 }];

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
  function left(sec) {
    if (sec <= 0) return 'ended';
    var m = Math.floor(sec / 60);
    if (m < 1) return 'under 1 min left';
    if (m < 60) return m + ' min left';
    var hr = Math.floor(m / 60), rest = m % 60;
    if (hr < 48) return hr + 'h' + (rest ? ' ' + rest + 'm' : '') + ' left';
    return Math.floor(hr / 24) + ' days left';
  }
  function agoShort(sec) {
    var m = Math.round(sec / 60);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    return Math.round(m / 60) + 'h ago';
  }
  function nameOf(id) {
    for (var i = 0; i < state.models.length; i++) if (state.models[i].id.toLowerCase() === String(id).toLowerCase()) return state.models[i].name;
    return id;
  }
  function namesOf(ids) { return ids.map(nameOf).join(', '); }

  var statusTimer = null;
  function say(msg, kind) {
    var el = $('status');
    el.textContent = msg || '';
    el.className = kind || '';
    clearTimeout(statusTimer);
    if (msg && kind !== 'error') statusTimer = setTimeout(function () { say(''); }, 6000);
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

  // ---- Multi-select dropdown ----
  var openMs = null;
  document.addEventListener('click', function (ev) { if (openMs && !openMs.el.contains(ev.target)) openMs.close(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && openMs) { var m = openMs; m.close(); m.focus(); }
  });

  function multiSelect(cfg) {
    var st = { options: [], selected: [], any: false, std: false };
    var btn = h('button', { type: 'button', class: 'ms-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-labelledby': cfg.labelId + ' ' + cfg.id + '-btn', id: cfg.id + '-btn' });
    var btnText = h('span', { text: '' });
    btn.appendChild(btnText);
    btn.appendChild(h('span', { class: 'ms-caret', 'aria-hidden': 'true', text: '\u25be' }));
    var search = h('input', { type: 'text', class: 'ms-search', placeholder: 'Search models', 'aria-label': 'Search models', autocomplete: 'off' });
    var anyCb = h('input', { type: 'checkbox' });
    var stdCb = h('input', { type: 'checkbox' });
    var anyRow = cfg.allowAny ? h('label', { class: 'ms-row ms-any' }, [anyCb, h('span', { class: 'ms-name', text: 'Any model' })]) : null;
    var stdRow = cfg.allowStandard ? h('label', { class: 'ms-row ms-any' }, [stdCb, h('span', { class: 'ms-name', text: 'All standard models' }), h('span', { class: 'ms-id', text: 'cheap ones, and any added later' })]) : null;
    var list = h('div', { class: 'ms-list' });
    var clearBtn = h('button', { type: 'button', text: 'Clear' });
    var doneBtn = h('button', { type: 'button', class: 'primary', text: 'Done' });
    var panel = h('div', { class: 'ms-panel', hidden: true, role: 'group', 'aria-label': cfg.title || 'Models' }, [search, anyRow, stdRow, list, h('div', { class: 'ms-foot' }, [clearBtn, doneBtn])]);
    var chips = h('div', { class: 'ms-chips' });
    var el = h('div', { class: 'ms' }, [btn, chips, panel]);
    var api_ = {
      el: el,
      focus: function () { btn.focus(); },
      close: function () { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (openMs === api_) openMs = null; },
      open: function () {
        if (openMs && openMs !== api_) openMs.close();
        panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); openMs = api_;
        search.value = ''; filter(); search.focus();
      },
      get: function () { return st.any ? ['*'] : (st.std ? ['@standard'] : []).concat(st.selected); },
      set: function (values) {
        st.any = values.indexOf('*') !== -1;
        st.std = values.indexOf('@standard') !== -1;
        st.selected = values.filter(function (v) { return v !== '*' && v !== '@standard'; });
        renderRows(); summary();
      },
      setOptions: function (options) { st.options = options.slice(); renderRows(); summary(); }
    };
    function optionsWithSelected() {
      var known = {}; st.options.forEach(function (o) { known[o.value.toLowerCase()] = true; });
      var extra = st.selected.filter(function (v) { return !known[v.toLowerCase()]; }).map(function (v) { return { value: v, label: v + ' (not in list)' }; });
      return st.options.concat(extra);
    }
    function labelFor(v) { var all = optionsWithSelected(); for (var i = 0; i < all.length; i++) if (all[i].value === v) return all[i].label; return v; }
    function renderRows() {
      clear(list);
      var all = optionsWithSelected();
      if (!all.length) list.appendChild(h('p', { class: 'ms-empty', text: cfg.emptyText || 'No models yet.' }));
      all.forEach(function (o) {
        var cb = h('input', { type: 'checkbox', value: o.value });
        cb.checked = st.selected.indexOf(o.value) !== -1;
        cb.disabled = st.any;
        cb.addEventListener('change', function () {
          if (cb.checked) { if (st.selected.indexOf(o.value) === -1) st.selected.push(o.value); }
          else st.selected = st.selected.filter(function (v) { return v !== o.value; });
          summary();
        });
        var row = h('label', { class: 'ms-row', 'data-text': (o.label + ' ' + o.value).toLowerCase() }, [cb, h('span', { class: 'ms-name', text: o.label }), h('span', { class: 'ms-id', text: o.value })]);
        list.appendChild(row);
      });
      anyCb.checked = st.any;
      stdCb.checked = st.std;
      filter();
    }
    function filter() {
      var q = search.value.trim().toLowerCase();
      Array.prototype.forEach.call(list.querySelectorAll('.ms-row'), function (row) { row.hidden = q !== '' && row.getAttribute('data-text').indexOf(q) === -1; });
    }
    function summary() {
      var n = st.selected.length;
      btnText.textContent = st.any ? 'Any model' : (st.std && n === 0) ? 'All standard models' : (st.std ? 'Standard + ' + n + ' more' : n === 0 ? (cfg.placeholder || 'Choose models') : n === 1 ? labelFor(st.selected[0]) : n + ' models selected');
      clear(chips);
      if (!st.any && st.std) chips.appendChild(h('span', { class: 'chip' }, ['All standard models']));
      if (!st.any) st.selected.forEach(function (v) {
        var x = h('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove ' + labelFor(v), text: '\u00d7' });
        x.addEventListener('click', function () { st.selected = st.selected.filter(function (s) { return s !== v; }); renderRows(); summary(); });
        chips.appendChild(h('span', { class: 'chip' }, [labelFor(v), x]));
      });
      if (cfg.onChange) cfg.onChange(api_.get());
    }
    btn.addEventListener('click', function () { if (panel.hidden) api_.open(); else api_.close(); });
    btn.addEventListener('keydown', function (ev) { if (ev.key === 'ArrowDown' && panel.hidden) { ev.preventDefault(); api_.open(); } });
    search.addEventListener('input', filter);
    search.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); return; }
      if (ev.key === 'ArrowDown') { var first = list.querySelector('.ms-row:not([hidden]) input:not(:disabled)'); if (first) { ev.preventDefault(); first.focus(); } }
    });
    anyCb.addEventListener('change', function () { st.any = anyCb.checked; renderRows(); summary(); });
    stdCb.addEventListener('change', function () { st.std = stdCb.checked; renderRows(); summary(); });
    clearBtn.addEventListener('click', function () { st.any = false; st.std = false; st.selected = []; renderRows(); summary(); search.focus(); });
    doneBtn.addEventListener('click', function () { api_.close(); btn.focus(); });
    return api_;
  }

  function catalogOptions() { return state.models.map(function (m) { return { value: m.id, label: m.name }; }); }
  var keyModels = multiSelect({ id: 'f-models', labelId: 'f-models-label', allowAny: true, allowStandard: true, placeholder: 'Choose models', title: 'Models this key can use', emptyText: 'No models yet. Add one in the Models section.' });
  var grantModels = multiSelect({ id: 'g-models', labelId: 'g-models-label', allowAny: false, placeholder: 'Choose models to unlock', title: 'Models to unlock', emptyText: 'No models to unlock.' });
  $('f-models-slot').appendChild(keyModels.el);
  $('g-models-slot').appendChild(grantModels.el);

  // ---- Keys ----
  function usedToday(k) { return k.tokens_today === null ? null : k.tokens_today; }

  function grantPills(k) {
    if (!k.grants.length && !k.ended_grants.length) return null;
    var box = h('div', { class: 'pills' });
    k.grants.forEach(function (g) {
      var t = h('span', { class: 'left', 'data-until': g.until, text: left(g.seconds_left) });
      var end = h('button', { type: 'button', text: 'End now', 'aria-label': 'End access to ' + namesOf(g.models) + ' for ' + k.name, onclick: function () { revokeGrant(k, g); } });
      box.appendChild(h('div', { class: 'pill', title: g.note ? 'Note: ' + g.note : '' }, [h('span', { text: namesOf(g.models) }), t, end]));
    });
    k.ended_grants.slice(0, 2).forEach(function (g) {
      box.appendChild(h('div', { class: 'pill ended' }, [h('span', { text: namesOf(g.models) }), h('span', { text: 'ended ' + agoShort(g.ended_seconds_ago) })]));
    });
    return box;
  }

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
      var usage;
      if (used === null) usage = h('div', { class: 'muted', text: 'Not tracked' });
      else if (k.daily_token_limit) {
        var pct = Math.min(100, Math.round(used / k.daily_token_limit * 100));
        var cls = 'meter' + (used >= k.daily_token_limit ? ' over' : pct >= 80 ? ' warn' : '');
        var meter = h('div', { class: cls, role: 'img', 'aria-label': pct + ' percent of the daily limit used' }, [h('span', { style: 'width:' + pct + '%' })]);
        usage = h('div', {}, [h('div', { title: full(used) + ' of ' + full(k.daily_token_limit), text: short(used) + ' of ' + short(k.daily_token_limit) + ' today' }), meter]);
      } else usage = h('div', {}, [h('div', { title: full(used), text: short(used) + ' today \u00b7 no cap' })]);

      var chips = h('div', { class: 'chips' }, k.models.map(function (m) { return h('span', { class: 'chip', text: m === '*' ? 'Any model' : m === '@standard' ? 'All standard models' : nameOf(m) }); }));
      var modelsCell = h('div', {}, [chips, k.models.indexOf('*') !== -1 ? h('p', { class: 'hint', text: 'Already has every model. To use Give access, switch this key to a smaller list first.' }) : null, grantPills(k)]);
      var status = h('div', {}, [
        h('span', { class: 'badge ' + (k.disabled ? 'disabled' : 'active'), text: k.disabled ? 'Disabled' : 'Active' }),
        k.admin ? h('span', { class: 'badge admin', text: 'Admin' }) : null
      ]);
      var canGrant = k.models.indexOf('*') === -1;
      var actions = h('div', { class: 'row-actions' }, [
        h('button', { type: 'button', text: 'Edit', onclick: function () { openForm(k); } }),
        h('button', { type: 'button', text: 'Give access', disabled: !canGrant, title: canGrant ? 'Give temporary access to more models' : 'This key can already use every model, so there is nothing to give', onclick: function () { openGrant(k); } }),
        h('button', { type: 'button', text: k.disabled ? 'Enable' : 'Disable', onclick: function () { toggle(k); } }),
        h('button', { type: 'button', class: 'danger', text: 'Delete', onclick: function () { remove(k); } })
      ]);
      list.appendChild(h('div', { class: 'krow' }, [
        h('div', { class: 'name' }, [k.name, h('div', { class: 'suffix', text: 'key ends in ' + k.key_suffix })]),
        modelsCell, usage, status, actions
      ]));
    });
  }

  function openForm(key) {
    closeGrant();
    state.editing = key || null;
    var form = $('key-form');
    $('form-title').textContent = key ? 'Edit ' + key.name : 'Add a key';
    $('f-name').value = key ? key.name : '';
    $('f-name').disabled = !!key;
    $('f-cap').value = key && key.daily_token_limit ? key.daily_token_limit : '';
    keyModels.setOptions(catalogOptions());
    keyModels.set(key ? key.models : []);
    $('f-save').textContent = key ? 'Save changes' : 'Create key';
    $('secret-panel').hidden = true;
    form.hidden = false;
    (key ? $('f-cap') : $('f-name')).focus();
    form.scrollIntoView({ block: 'nearest' });
  }
  function closeForm() { $('key-form').hidden = true; state.editing = null; keyModels.close(); }

  function submitForm(ev) {
    ev.preventDefault();
    var models = keyModels.get();
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

  // ---- Temporary access ----
  var grantState = { minutes: 120, custom: false };
  function grantMinutes() {
    if (!grantState.custom) return grantState.minutes;
    var n = Number($('g-custom').value);
    var unit = Number($('g-unit').value);
    return n > 0 ? Math.round(n * unit) : NaN;
  }
  function renderDurations() {
    var seg = $('g-presets');
    clear(seg);
    PRESETS.forEach(function (p) {
      seg.appendChild(h('button', { type: 'button', text: p.label, 'aria-pressed': String(!grantState.custom && grantState.minutes === p.minutes), onclick: function () { grantState.custom = false; grantState.minutes = p.minutes; renderDurations(); } }));
    });
    seg.appendChild(h('button', { type: 'button', text: 'Custom', 'aria-pressed': String(grantState.custom), onclick: function () { grantState.custom = true; renderDurations(); $('g-custom').focus(); } }));
    $('g-custom-row').hidden = !grantState.custom;
    updatePreview();
  }
  function updatePreview() {
    var m = grantMinutes();
    var el = $('g-preview');
    if (!(m >= 1 && m <= 10080)) { el.textContent = grantState.custom ? 'Enter a length from 1 minute to 7 days.' : ''; return; }
    var end = new Date(Date.now() + m * 60000);
    el.textContent = 'Access ends ' + end.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' (' + left(m * 60).replace(' left', '') + ' from now).';
  }
  function openGrant(k) {
    closeForm();
    state.granting = k;
    $('grant-title').textContent = 'Give ' + k.name + ' temporary access';
    var have = {};
    var std = k.models.indexOf('@standard') !== -1;
    k.models.forEach(function (m) { have[m.toLowerCase()] = true; });
    state.models.forEach(function (m) { if (std && m.access === 'standard') have[m.id.toLowerCase()] = true; });
    grantModels.setOptions(catalogOptions().filter(function (o) { return !have[o.value.toLowerCase()]; }));
    grantModels.set([]);
    grantState.custom = false; grantState.minutes = 120;
    $('g-custom').value = '3'; $('g-unit').value = '60'; $('g-note').value = '';
    renderDurations();
    $('secret-panel').hidden = true;
    $('grant-form').hidden = false;
    $('grant-form').scrollIntoView({ block: 'nearest' });
    $('g-models-btn').focus();
  }
  function closeGrant() { $('grant-form').hidden = true; state.granting = null; grantModels.close(); }
  function submitGrant(ev) {
    ev.preventDefault();
    var k = state.granting;
    if (!k) return;
    var models = grantModels.get();
    if (!models.length) { say('Choose at least one model to unlock.', 'error'); return; }
    var minutes = grantMinutes();
    if (!(minutes >= 1 && minutes <= 10080)) { say('Choose how long: from 1 minute to 7 days.', 'error'); return; }
    var btn = $('g-save');
    btn.disabled = true;
    api('POST', '/admin/keys/' + encodeURIComponent(k.name) + '/grants', { models: models, minutes: minutes, note: $('g-note').value.trim() || undefined })
      .then(function (res) {
        closeGrant();
        say(k.name + ' can use ' + namesOf(models) + ' for ' + left(res.grant.seconds_left).replace(' left', '') + '.', 'ok');
        return refresh();
      }).catch(fail).then(function () { btn.disabled = false; });
  }
  function revokeGrant(k, g) {
    if (!window.confirm('End ' + k.name + "'s access to " + namesOf(g.models) + ' now?')) return;
    api('DELETE', '/admin/keys/' + encodeURIComponent(k.name) + '/grants/' + encodeURIComponent(g.id))
      .then(function () { say('Ended ' + k.name + "'s access to " + namesOf(g.models) + '.', 'ok'); return refresh(); }).catch(fail);
  }

  // ---- Models ----
  function accessSelect(current, onChange) {
    var sel = h('select', { 'aria-label': 'Who is it listed for' }, [
      h('option', { value: 'standard', text: 'Keys that can use it' }),
      h('option', { value: 'on_request', text: 'Everyone, marked on request' })
    ]);
    sel.value = current;
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }
  function renderModels() {
    var box = $('models');
    clear(box);
    $('models-note').textContent = state.modelSource === 'default' ? 'Using the built-in list. Change it and your list is saved.' : '';
    var syncBox = $('go-sync-box');
    clear(syncBox);
    if (state.go && state.go.connected) {
      var n = state.go.keys.length;
      syncBox.appendChild(h('p', { class: 'hint', text: 'OpenCode Go is connected with ' + n + ' key' + (n === 1 ? '' : 's') + '. Cheap Go models are added as standard and the more expensive ones as on request.' }));
      syncBox.appendChild(h('button', { type: 'button', id: 'go-sync', text: 'Add or refresh OpenCode Go models', onclick: syncGo }));
    }
    box.appendChild(h('div', { class: 'mrow head', 'aria-hidden': 'true' }, [h('div', { text: 'Name' }), h('div', { text: 'Model id' }), h('div', { text: 'Listed in OpenCode for' }), h('div', { text: '' })]));
    state.models.forEach(function (m) {
      var sel = accessSelect(m.access, function (value) {
        api('POST', '/admin/models', { id: m.id, name: m.name, access: value })
          .then(function () { say(m.name + ' is now listed for ' + (value === 'on_request' ? 'everyone, marked on request' : 'keys that can use it') + '.', 'ok'); return refresh(); }).catch(fail);
      });
      var rm = h('button', { type: 'button', class: 'danger', text: 'Remove', 'aria-label': 'Remove ' + m.name, onclick: function () {
        if (!window.confirm('Remove ' + m.name + ' from the list? Keys that already have it keep working; it just stops being offered here.')) return;
        api('DELETE', '/admin/models/' + encodeURIComponent(m.id)).then(function () { say('Removed ' + m.name + '.', 'ok'); return refresh(); }).catch(fail);
      } });
      box.appendChild(h('div', { class: 'mrow' }, [h('div', { class: 'name', text: m.name }), h('div', { class: 'muted', text: m.id }), sel, rm]));
    });
    if (!state.models.length) box.appendChild(h('p', { class: 'empty', text: 'No models yet. Add one below.' }));
  }
  function syncGo() {
    var btn = $('go-sync');
    btn.disabled = true;
    api('POST', '/admin/go/sync')
      .then(function (res) {
        var n = res.added.length;
        say(n ? 'Added ' + n + ' OpenCode Go model' + (n === 1 ? '' : 's') + ' to the list.' : 'The list already has every OpenCode Go model.', 'ok');
        return refresh();
      }).catch(fail).then(function () { var b = $('go-sync'); if (b) b.disabled = false; });
  }
  function submitModel(ev) {
    ev.preventDefault();
    var id = $('m-id').value.trim(), name = $('m-name').value.trim();
    if (!id) { say('Enter the model id, for example claude-opus-5-5.', 'error'); return; }
    var btn = $('m-add');
    btn.disabled = true;
    api('POST', '/admin/models', { id: id, name: name || id, access: $('m-access').value })
      .then(function () { $('m-id').value = ''; $('m-name').value = ''; say('Added ' + (name || id) + '.', 'ok'); return refresh(); })
      .catch(fail).then(function () { btn.disabled = false; });
  }

  // ---- Usage ----
  function renderUsage() {
    var u = state.usage;
    var people = $('by-person');
    var details = $('details');
    clear(people); clear(details);
    if (!u) {
      people.appendChild(h('p', { class: 'empty', text: 'Usage tracking is turned off on this relay.' }));
      return;
    }
    if (!u.rows.length) {
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
    Array.prototype.forEach.call(document.querySelectorAll('.seg[aria-label=Period] button'), function (b) { b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-days')) === n)); });
    refresh();
  }

  function refresh() {
    $('refresh').disabled = true;
    // Usage is optional: a relay with stats turned off answers 409 there, and that must not stop the keys from loading.
    var usageReq = api('GET', '/admin/usage?days=' + state.days).catch(function (err) { if (err.status === 409) return null; throw err; });
    var goReq = api('GET', '/admin/go').catch(function (err) { if (err.status === 401) throw err; return null; });
    return Promise.all([api('GET', '/admin/keys'), usageReq, api('GET', '/admin/models'), goReq]).then(function (res) {
      state.keys = res[0].keys;
      state.usage = res[1];
      state.models = res[2].models;
      state.modelSource = res[2].source;
      state.go = res[3];
      renderKeys();
      renderModels();
      renderUsage();
      if (!$('key-form').hidden) keyModels.setOptions(catalogOptions());
      $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
      $('loading').hidden = true;
    }).catch(function (err) { $('loading').hidden = true; fail(err); }).then(function () { $('refresh').disabled = false; });
  }

  // Countdowns tick on their own; one refresh when a grant runs out so the row settles.
  setInterval(function () {
    var expired = false;
    Array.prototype.forEach.call(document.querySelectorAll('[data-until]'), function (el) {
      var sec = Math.round((Date.parse(el.getAttribute('data-until')) - Date.now()) / 1000);
      el.textContent = left(sec);
      if (sec <= 0) expired = true;
    });
    if (expired && !$('app').hidden) refresh();
    if (!$('grant-form').hidden) updatePreview();
  }, 15000);

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
  $('grant-form').addEventListener('submit', submitGrant);
  $('g-cancel').addEventListener('click', closeGrant);
  $('g-custom').addEventListener('input', updatePreview);
  $('g-unit').addEventListener('change', updatePreview);
  $('model-form').addEventListener('submit', submitModel);
  $('copy-btn').addEventListener('click', copySecret);
  $('secret-done').addEventListener('click', hideSecret);
  Array.prototype.forEach.call(document.querySelectorAll('.seg[aria-label=Period] button'), function (b) {
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
              <label id="f-models-label">Models this key can use</label>
              <div id="f-models-slot"></div>
              <p class="hint">Need a model for a limited time instead? Save the key, then use Give access on its row.</p>
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

      <form id="grant-form" hidden>
        <div class="panel flat">
          <h2 id="grant-title" class="mb"></h2>
          <div class="form-grid">
            <div>
              <label id="g-models-label">Models to unlock</label>
              <div id="g-models-slot"></div>
            </div>
            <div>
              <label>For how long</label>
              <div class="dur"><div id="g-presets" class="seg" role="group" aria-label="Duration"></div></div>
              <div id="g-custom-row" class="dur-custom" hidden>
                <input id="g-custom" type="number" min="1" step="1" inputmode="numeric" aria-label="Custom length">
                <select id="g-unit" aria-label="Unit">
                  <option value="1">minutes</option>
                  <option value="60">hours</option>
                  <option value="1440">days</option>
                </select>
              </div>
              <div id="g-preview" class="preview" aria-live="polite"></div>
            </div>
            <div>
              <label for="g-note">Note (optional)</label>
              <input id="g-note" type="text" maxlength="200" placeholder="Why, for example: dashboard redesign" autocomplete="off">
              <p class="hint">Saved with the grant and shown when you hover over it. They get their normal models back automatically when time runs out.</p>
            </div>
            <div class="form-actions">
              <button id="g-save" class="primary" type="submit">Give access</button>
              <button id="g-cancel" type="button">Cancel</button>
            </div>
          </div>
        </div>
      </form>

      <p id="loading" class="empty">Loading keys&hellip;</p>
      <div id="keys"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Models</h2>
      </div>
      <p class="hint">These are the models you can give out and that teammates see in OpenCode. Keys can only use what you allow them, whatever is listed here.</p>
      <p id="models-note" class="hint"></p>
      <div id="go-sync-box" class="mb"></div>
      <div id="models"></div>
      <form id="model-form" class="madd">
        <div>
          <label for="m-id">Model id</label>
          <input id="m-id" type="text" placeholder="claude-opus-5-5" autocomplete="off" spellcheck="false">
        </div>
        <div>
          <label for="m-name">Name shown</label>
          <input id="m-name" type="text" maxlength="80" placeholder="Claude Opus 5.5" autocomplete="off">
        </div>
        <div>
          <label for="m-access">Listed in OpenCode for</label>
          <select id="m-access">
            <option value="on_request">Everyone, marked on request</option>
            <option value="standard">Keys that can use it</option>
          </select>
        </div>
        <button id="m-add" class="primary" type="submit">Add model</button>
      </form>
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
