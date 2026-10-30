import { SHARED_JS } from "./shared";

export const JS = String.raw`
(function () {
  'use strict';
  var TABS = ['requests', 'keys', 'models', 'usage'];
  var PRESETS = [{ label: '2 hours', minutes: 120 }, { label: '4 hours', minutes: 240 }, { label: '8 hours', minutes: 480 }, { label: '24 hours', minutes: 1440 }];
  var SEARCH_AFTER = 8;
  var state = {
    loaded: false, loadError: null, lastLoad: 0,
    keys: [], usage: null, statsOff: false, models: [], go: null, requests: [],
    tab: null, days: 1,
    adding: false, editing: null, granting: null, inviting: null, addingModel: false,
    keyFilter: '', modelFilter: '', decidedOpen: false, newModelAccess: 'on_request'
  };

  ${SHARED_JS}
  function nameOf(id) {
    for (var i = 0; i < state.models.length; i++) if (state.models[i].id.toLowerCase() === String(id).toLowerCase()) return state.models[i].name;
    return id;
  }
  function plainName(id) { return nameOf(id).replace(/\s*\(OpenCode Go\)$/, ''); }
  function listNames(ids) {
    var n = ids.map(nameOf);
    return n.length <= 1 ? n.join('') : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
  }
  // ---- Feedback ----
  var confirmResolve = null;
  function finishConfirm(value) {
    var done = confirmResolve;
    confirmResolve = null;
    if ($('confirm').open) $('confirm').close();
    if (done) done(value);
  }
  function confirmDialog(o) {
    return new Promise(function (resolve) {
      finishConfirm(false);
      confirmResolve = resolve;
      $('confirm-title').textContent = o.title;
      $('confirm-body').textContent = o.body;
      $('confirm-yes').textContent = o.yes;
      $('confirm-no').textContent = o.no || 'Keep it';
      $('confirm').showModal();
      $('confirm-no').focus();
    });
  }
  $('confirm-yes').addEventListener('click', function () { finishConfirm(true); });
  $('confirm-no').addEventListener('click', function () { finishConfirm(false); });
  $('confirm').addEventListener('close', function () { finishConfirm(false); });

  function showLogin(message) {
    $('app').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = message || '';
    $('password').value = '';
    $('username').focus();
  }
  function fail(err) {
    if (err.status === 401) { showLogin('Your session ended. Sign in again.'); return; }
    say(err.message, 'error');
  }

  // ---- Address bar state (tab and period live in the URL) ----
  function urlGet() {
    var p = new URLSearchParams(location.search);
    var d = Number(p.get('days'));
    return { tab: p.get('tab'), days: d === 7 || d === 30 ? d : 1 };
  }
  function urlSet(changes, replace) {
    var p = new URLSearchParams(location.search);
    Object.keys(changes).forEach(function (k) { if (changes[k] === null) p.delete(k); else p.set(k, String(changes[k])); });
    var qs = p.toString();
    history[replace ? 'replaceState' : 'pushState'](null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  // ---- Tabs ----
  function pendingRequests() {
    return state.requests.filter(function (r) { return r.status === 'pending'; })
      .sort(function (a, b) { return Date.parse(a.requested_at) - Date.parse(b.requested_at); });
  }
  function currentTab() {
    if (state.tab && TABS.indexOf(state.tab) !== -1) return state.tab;
    return pendingRequests().length ? 'requests' : 'keys';
  }
  function applyTab() {
    var cur = currentTab();
    TABS.forEach(function (t) {
      var on = state.loaded && t === cur;
      $('panel-' + t).hidden = !on;
      var b = $('tab-' + t);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = t === cur ? 0 : -1;
    });
  }
  function goTab(tab, push) {
    state.tab = tab;
    if (push) urlSet({ tab: tab }, false);
    applyTab();
  }
  TABS.forEach(function (t, i) {
    var b = $('tab-' + t);
    b.addEventListener('click', function () { goTab(t, true); });
    b.addEventListener('keydown', function (ev) {
      var next = ev.key === 'ArrowRight' ? i + 1 : ev.key === 'ArrowLeft' ? i - 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? TABS.length - 1 : -1;
      if (next < 0) return;
      ev.preventDefault();
      var to = TABS[(next + TABS.length) % TABS.length];
      goTab(to, true);
      $('tab-' + to).focus();
    });
  });
  window.addEventListener('popstate', function () {
    var u = urlGet();
    var daysChanged = u.days !== state.days;
    state.tab = u.tab;
    state.days = u.days;
    syncPeriod();
    applyTab();
    if (daysChanged && state.loaded) loadUsage();
  });

  // ---- Row menu (the three dots) ----
  var openMenu = null;
  document.addEventListener('click', function (ev) { if (openMenu && !openMenu.el.contains(ev.target)) openMenu.close(); });
  function rowMenu(label, items) {
    var btn = h('button', { type: 'button', class: 'kebab', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': label, text: '\u22ee' });
    var panel = h('div', { class: 'menu', role: 'menu', hidden: true });
    var el = h('div', { class: 'rmenu' }, [btn, panel]);
    var api_ = {
      el: el,
      close: function () { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (openMenu === api_) openMenu = null; },
      open: function () {
        if (openMenu) openMenu.close();
        panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); openMenu = api_;
        var first = panel.querySelector('button'); if (first) first.focus();
      }
    };
    items.forEach(function (it) {
      if (it === 'sep') { panel.appendChild(h('hr')); return; }
      panel.appendChild(h('button', { type: 'button', role: 'menuitem', class: it.bad ? 'bad' : '', text: it.text, onclick: function () { api_.close(); btn.focus(); it.run(); } }));
    });
    btn.addEventListener('click', function () { if (panel.hidden) api_.open(); else api_.close(); });
    el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !panel.hidden) { ev.stopPropagation(); api_.close(); btn.focus(); return; }
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      ev.preventDefault();
      if (panel.hidden) { api_.open(); return; }
      var buttons = Array.prototype.slice.call(panel.querySelectorAll('button'));
      var at = buttons.indexOf(document.activeElement);
      var to = ev.key === 'ArrowDown' ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
      buttons[to].focus();
    });
    return api_;
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
    var search = h('input', { type: 'search', class: 'ms-search', placeholder: 'Search models', 'aria-label': 'Search models', autocomplete: 'off' });
    var anyCb = h('input', { type: 'checkbox' });
    var stdCb = h('input', { type: 'checkbox' });
    var anyRow = cfg.allowAny ? h('label', { class: 'ms-row ms-any' }, [anyCb, h('span', { class: 'ms-name', text: 'Any model' })]) : null;
    var stdRow = cfg.allowStandard ? h('label', { class: 'ms-row ms-any' }, [stdCb, h('span', { class: 'ms-name', text: 'All standard models' }), h('span', { class: 'ms-id', text: 'and any added later' })]) : null;
    var list = h('div', { class: 'ms-list' });
    var clearBtn = h('button', { type: 'button', class: 'quiet', text: 'Clear' });
    var doneBtn = h('button', { type: 'button', class: 'primary quiet', text: 'Done' });
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
        list.appendChild(h('label', { class: 'ms-row', 'data-text': (o.label + ' ' + o.value).toLowerCase() }, [cb, h('span', { class: 'ms-name', text: o.label }), h('span', { class: 'ms-id', text: o.value })]));
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
      if (!st.any && (st.std || n >= 2)) st.selected.forEach(function (v) {
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
  var keyModels = multiSelect({
    id: 'f-models', labelId: 'f-models-label', allowAny: true, allowStandard: true, placeholder: 'Choose models', title: 'Models this key can use',
    emptyText: 'No models yet. Add one in the Models tab.',
    onChange: function (values) { $('f-any-hint').hidden = values.indexOf('*') === -1; }
  });
  var grantModels = multiSelect({ id: 'g-models', labelId: 'g-models-label', allowAny: false, placeholder: 'Choose models to lend', title: 'Models to lend', emptyText: 'This key already has every model on the list.' });
  $('f-models-slot').appendChild(keyModels.el);
  $('g-models-slot').appendChild(grantModels.el);

  // ---- Requests ----
  function lengthOptions(asked) {
    var opts = [60, 120, 240, 480, 1440];
    if (opts.indexOf(asked) === -1) opts.push(asked);
    return opts.sort(function (a, b) { return a - b; });
  }
  function decide(r, action, minutes, note, buttons) {
    buttons.forEach(function (b) { b.disabled = true; });
    var body = { note: note || undefined };
    if (action === 'approve') body.minutes = minutes;
    api('POST', '/admin/access-requests/' + encodeURIComponent(r.id) + '/' + action, body)
      .then(function () {
        say(action === 'approve' ? r.key + ' can use ' + listNames(r.models) + ' for ' + minutesText(minutes) + '.' : 'Rejected ' + r.key + "'s request.", 'ok');
        return load();
      }).catch(function (err) { fail(err); load(); });
  }
  function requestCard(r) {
    var minutes = r.requested_minutes;
    var approve = h('button', { type: 'button', class: 'primary', text: 'Approve for ' + minutesText(minutes) });
    var reject = h('button', { type: 'button', text: 'Reject' });
    var sel = h('select', { 'aria-label': 'How long to lend it to ' + r.key });
    lengthOptions(r.requested_minutes).forEach(function (m) { sel.appendChild(h('option', { value: String(m), text: minutesText(m) + (m === r.requested_minutes ? ' (asked for)' : '') })); });
    sel.value = String(minutes);
    var note = h('input', { type: 'text', maxlength: '200', placeholder: 'Note for ' + r.key + ' (optional)', 'aria-label': 'Note for ' + r.key });
    var more = h('div', { class: 'rq-more', hidden: true }, [sel, note]);
    var toggle = h('button', { type: 'button', class: 'link', text: 'Change time or add a note', 'aria-expanded': 'false' });
    toggle.addEventListener('click', function () { more.hidden = !more.hidden; toggle.setAttribute('aria-expanded', String(!more.hidden)); if (!more.hidden) sel.focus(); });
    sel.addEventListener('change', function () { minutes = Number(sel.value); approve.textContent = 'Approve for ' + minutesText(minutes); });
    approve.addEventListener('click', function () { decide(r, 'approve', minutes, note.value.trim(), [approve, reject]); });
    reject.addEventListener('click', function () { decide(r, 'reject', 0, note.value.trim(), [approve, reject]); });
    return h('div', { class: 'card rq' }, [
      h('div', { class: 'rq-top' }, [h('strong', { text: r.key }), h('span', { class: 'muted small', title: when(r.requested_at), text: 'asked ' + ago(r.requested_at) })]),
      h('div', { class: 'rq-what' }, ['wants ', h('strong', { text: listNames(r.models) }), ' for ' + minutesText(r.requested_minutes)]),
      h('div', { class: 'rq-why', text: r.reason }),
      h('div', { class: 'rq-acts' }, [approve, reject, toggle]),
      more
    ]);
  }
  function renderRequests() {
    var box = $('requests');
    clear(box);
    var pending = pendingRequests();
    var decided = state.requests.filter(function (r) { return r.status === 'approved' || r.status === 'rejected'; }).slice(0, 10);
    var badge = $('req-count');
    badge.hidden = !pending.length;
    badge.textContent = String(pending.length);
    badge.setAttribute('aria-label', pending.length + ' waiting');
    var stack = h('div', { class: 'stack' });
    if (!pending.length) stack.appendChild(h('div', { class: 'card' }, [stateBox('No requests waiting', 'When someone asks for a model their key does not have, you will see who asked and why, and can approve or reject it here.')]));
    pending.forEach(function (r) { stack.appendChild(requestCard(r)); });
    if (decided.length) {
      var fold = h('details', { class: 'fold' }, [h('summary', {}, ['Recent decisions ', h('span', { class: 'muted', text: '(' + decided.length + ')' })])]);
      if (state.decidedOpen) fold.open = true;
      fold.addEventListener('toggle', function () { state.decidedOpen = fold.open; });
      var inner = h('div', { class: 'inner' });
      decided.forEach(function (r) {
        var yes = r.status === 'approved';
        var tail = yes ? (r.seconds_left > 0 ? left(r.seconds_left) : 'ended') : (r.decision_note ? r.decision_note : '');
        inner.appendChild(h('div', { class: 'done' }, [
          h('div', {}, [h('span', { class: 'verdict ' + (yes ? 'yes' : 'no'), text: yes ? 'Approved' : 'Rejected' }), ' \u00b7 ' + r.key + ' \u00b7 ' + listNames(r.models) + (tail ? ' \u00b7 ' + tail : '')]),
          h('div', { class: 'meta', text: '\u201c' + r.reason + '\u201d' }),
          h('div', { class: 'meta', title: r.decided_at ? when(r.decided_at) : '', text: 'by ' + r.decided_by + (r.decided_at ? ' ' + ago(r.decided_at) : '') + (yes && r.decision_note ? ' \u00b7 note: ' + r.decision_note : '') })
        ]));
      });
      fold.appendChild(inner);
      stack.appendChild(fold);
    }
    box.appendChild(stack);
  }

  // ---- Keys ----
  var keySearch = h('input', { type: 'search', placeholder: 'Search keys', 'aria-label': 'Search keys', autocomplete: 'off' });
  var keyCount = h('span', { class: 'title' });
  var addKeyBtn = h('button', { type: 'button', class: 'primary', id: 'add-key', text: 'Add key' });
  var keysLeft = h('div', { class: 'bar-left' }, [keySearch, keyCount]);
  $('keys-bar').appendChild(keysLeft);
  $('keys-bar').appendChild(h('div', { class: 'acts' }, [addKeyBtn]));
  keySearch.addEventListener('input', function () { state.keyFilter = keySearch.value.trim().toLowerCase(); renderKeys(); });
  addKeyBtn.addEventListener('click', function () { openForm(null); });

  function sortedKeys() {
    return state.keys.slice().sort(function (a, b) {
      if (!!a.disabled !== !!b.disabled) return a.disabled ? 1 : -1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  }
  function accessSummary(k) {
    var m = k.models;
    if (m.indexOf('*') !== -1) return { text: 'Every model', title: '' };
    var named = m.filter(function (x) { return x !== '@standard'; }).map(nameOf);
    var parts = [];
    if (m.indexOf('@standard') !== -1) parts.push('All standard models');
    if (named.length) parts.push(named.length <= 3 ? named.join(', ') : named.slice(0, 3).join(', ') + ' +' + (named.length - 3) + ' more');
    return { text: parts.join(' + '), title: named.join(', ') };
  }
  function usageCell(k) {
    var cell = h('div', { class: 'k-use' });
    var used = k.tokens_today;
    if (state.statsOff || used === null) return cell;
    var limit = k.daily_token_limit;
    if (limit) {
      var pct = Math.min(100, Math.round(used / limit * 100));
      var level = used >= limit ? 'over' : pct >= 80 ? 'near' : '';
      cell.appendChild(h('div', { class: 'line num', title: full(used) + ' of ' + full(limit) + ' tokens today', text: short(used) + ' of ' + short(limit) + ' tokens' }));
      if (level === 'over') cell.appendChild(h('div', { class: 'over', text: 'Daily limit reached' }));
      else if (level === 'near') cell.appendChild(h('div', { class: 'near', text: 'Close to its daily limit' }));
      var bar = h('div', { class: 'meter ' + level, role: 'img', 'aria-label': pct + ' percent of the daily limit used' }, [h('span')]);
      bar.firstChild.style.width = pct + '%';
      cell.appendChild(bar);
    } else if (used > 0) cell.appendChild(h('div', { class: 'line num', title: full(used) + ' tokens today', text: short(used) + ' tokens' }));
    else cell.appendChild(h('div', { class: 'muted small', text: 'None today' }));
    return cell;
  }
  function loansFor(k) {
    if (!k.grants.length) return null;
    var box = h('div', { class: 'loans' });
    k.grants.forEach(function (g) {
      var t = h('span', { class: 'left', 'data-until': g.until, text: left(g.seconds_left) });
      var end = h('button', { type: 'button', text: 'End now', 'aria-label': 'End ' + k.name + "'s access to " + listNames(g.models), onclick: function () { endLoan(k, g); } });
      box.appendChild(h('div', { class: 'loan', title: g.note ? 'Why: ' + g.note : '' }, [h('span', { text: listNames(g.models) }), t, end]));
    });
    return box;
  }
  function keyRow(k) {
    var any = k.models.indexOf('*') !== -1;
    var acc = accessSummary(k);
    var chips = [];
    if (k.admin) chips.push(h('span', { class: 'chip', text: 'Admin' }));
    if (k.disabled) chips.push(h('span', { class: 'chip off', text: 'Disabled' }));
    if (k.invite && !k.login) chips.push(h('span', { class: 'chip', title: 'Link sent to ' + k.invite.email, text: 'Invite pending' }));
    var name = h('div', { class: 'k-name', title: 'Key ends in ' + k.key_suffix }, [h('strong', { text: k.name }), k.login ? h('div', { class: 'muted small', title: 'Signs in to the account page with this email', text: k.login }) : null, chips.length ? h('div', { class: 'chips' }, chips) : null]);
    var access = h('div', { class: 'k-access' }, [h('div', { class: 'sum', title: acc.title, text: acc.text }), loansFor(k)]);
    var primary = h('div', { class: 'k-primary' }, [any
      ? h('button', { type: 'button', text: 'Edit', 'aria-label': 'Edit ' + k.name, onclick: function () { openForm(k); } })
      : h('button', { type: 'button', text: 'Give access', 'aria-label': 'Give ' + k.name + ' temporary access', onclick: function () { openGrant(k); } })]);
    var items = [];
    if (!any) items.push({ text: 'Edit access and limit', run: function () { openForm(k); } });
    items.push({ text: k.disabled ? 'Enable key' : 'Disable key', run: function () { toggleKey(k); } });
    items.push({ text: k.login || k.invite ? 'Send a new sign-in link' : 'Invite to sign in', run: function () { openInvite(k); } });
    if (k.login) items.push({ text: 'Remove sign-in', run: function () { removeLogin(k); } });
    items.push('sep');
    items.push({ text: 'Delete key', bad: true, run: function () { removeKey(k); } });
    var menu = rowMenu('More actions for ' + k.name, items);
    return h('div', { class: 'krow' + (k.disabled ? ' dim' : ''), 'data-key': k.name }, [h('div', { class: 'krow-main' }, [name, access, usageCell(k), primary, menu.el])]);
  }
  function findRow(name) {
    var rows = $('keys').querySelectorAll('.krow[data-key]');
    for (var i = 0; i < rows.length; i++) if (rows[i].getAttribute('data-key') === name) return rows[i];
    return null;
  }
  function parkForms() { $('form-holder').appendChild($('key-form')); $('form-holder').appendChild($('grant-form')); $('form-holder').appendChild($('invite-form')); }
  function placeForms() {
    var list = $('keys');
    if (state.adding) { list.insertBefore($('key-form'), list.firstChild); return; }
    var row;
    if (state.editing && (row = findRow(state.editing))) { row.parentNode.insertBefore($('key-form'), row.nextSibling); return; }
    if (state.granting && (row = findRow(state.granting))) { row.parentNode.insertBefore($('grant-form'), row.nextSibling); return; }
    if (state.inviting && (row = findRow(state.inviting))) { row.parentNode.insertBefore($('invite-form'), row.nextSibling); return; }
    state.editing = null; state.granting = null; state.inviting = null;
  }
  function renderKeysBar() {
    var many = state.keys.length > SEARCH_AFTER;
    keySearch.hidden = !many;
    keyCount.hidden = many || !state.keys.length;
    keyCount.textContent = plural(state.keys.length, 'key');
    keysLeft.className = 'bar-left' + (many ? '' : ' counting');
    $('keys-bar').hidden = !state.keys.length && !state.adding;
    addKeyBtn.hidden = state.adding || !!state.editing || !!state.granting || !!state.inviting || !state.keys.length;
    $('f-cap-wrap').hidden = state.statsOff;
  }
  function renderKeys() {
    var list = $('keys');
    parkForms();
    clear(list);
    renderKeysBar();
    if (!state.keys.length) {
      if (!state.adding) list.appendChild(h('div', { class: 'card' }, [stateBox('No keys yet', 'A key lets one person or app use the relay. Create one and send it to them.', h('button', { type: 'button', class: 'primary', text: 'Add key', onclick: function () { openForm(null); } }))]));
      placeForms();
      return;
    }
    var rows = sortedKeys().filter(function (k) { return !state.keyFilter || k.name.toLowerCase().indexOf(state.keyFilter) !== -1; });
    if (!rows.length) {
      list.appendChild(h('div', { class: 'card' }, [stateBox('No keys match', 'Nothing is named like "' + state.keyFilter + '".')]));
      placeForms();
      return;
    }
    var card = h('div', { class: 'card' });
    var headMain = h('div', { class: 'krow-main' }, [h('div', { text: 'Name' }), h('div', { text: 'Can use' }), h('div', { text: state.statsOff ? '' : 'Used today' }), h('div'), h('div')]);
    card.appendChild(h('div', { class: 'krow head', 'aria-hidden': 'true' }, [headMain]));
    rows.forEach(function (k) { card.appendChild(keyRow(k)); });
    list.appendChild(card);
    placeForms();
  }

  function openInvite(k) {
    if (state.adding || state.editing) closeForm();
    closeGrant(true);
    state.inviting = k.name;
    $('invite-title').textContent = (k.login ? 'New sign-in link for ' : 'Invite ') + k.name + (k.login ? '' : ' to sign in');
    $('i-email').value = k.login || (k.invite ? k.invite.email : '');
    $('secret-panel').hidden = true;
    $('link-panel').hidden = true;
    renderKeys();
    $('i-email').focus();
    $('invite-form').scrollIntoView({ block: 'nearest' });
  }
  function closeInvite() { state.inviting = null; renderKeys(); }
  function submitInvite(ev) {
    ev.preventDefault();
    var name = state.inviting;
    if (!name) return;
    var btn = $('i-save');
    btn.disabled = true;
    api('POST', '/admin/keys/' + encodeURIComponent(name) + '/invite', { email: $('i-email').value.trim() })
      .then(function (res) {
        state.inviting = null;
        $('link-name').textContent = res.key;
        $('link-note').textContent = 'Send this to ' + res.email + '. It works once and expires ' + when(res.expires_at) + '.';
        $('link-value').textContent = res.link;
        $('link-copy').textContent = 'Copy link';
        $('link-panel').hidden = false;
        say('Link ready for ' + res.email + '.', 'ok');
        return load().then(function () { $('link-panel').scrollIntoView({ block: 'nearest' }); });
      }).catch(fail).then(function () { btn.disabled = false; });
  }
  function copyLink() {
    var text = $('link-value').textContent;
    var done = function () { $('link-copy').textContent = 'Copied'; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { selectNode($('link-value')); });
    else selectNode($('link-value'));
  }
  function selectNode(node) {
    var range = document.createRange();
    range.selectNodeContents(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    say('Press Ctrl+C or Cmd+C to copy.', 'ok');
  }
  function removeLogin(k) {
    confirmDialog({ title: 'Remove ' + k.name + "'s sign-in?", body: k.login + ' can no longer sign in to the account page. Their key keeps working.', yes: 'Remove sign-in', no: 'Keep it' }).then(function (yes) {
      if (!yes) return;
      return api('DELETE', '/admin/keys/' + encodeURIComponent(k.name) + '/login').then(function () { say('Removed ' + k.name + "'s sign-in.", 'ok'); return load(); }).catch(fail);
    });
  }

  function openForm(key) {
    closeGrant(true);
    state.inviting = null;
    state.adding = !key;
    state.editing = key ? key.name : null;
    $('form-title').textContent = key ? 'Edit ' + key.name : 'New key';
    $('f-suffix').hidden = !key;
    $('f-suffix').textContent = key ? 'Key ends in ' + key.key_suffix + '.' : '';
    $('f-name-wrap').hidden = !!key;
    $('f-name').required = !key;
    $('f-name').value = key ? key.name : '';
    $('f-cap').value = key && key.daily_token_limit ? key.daily_token_limit : '';
    keyModels.setOptions(catalogOptions());
    keyModels.set(key ? key.models : ['@standard']);
    $('f-save').textContent = key ? 'Save changes' : 'Create key';
    $('secret-panel').hidden = true;
    renderKeys();
    (key ? $('f-models-btn') : $('f-name')).focus();
    $('key-form').scrollIntoView({ block: 'nearest' });
  }
  function closeForm() {
    var was = state.editing;
    state.adding = false; state.editing = null; keyModels.close();
    renderKeys();
    return was;
  }
  function submitForm(ev) {
    ev.preventDefault();
    var models = keyModels.get();
    if (!models.length) { say('Pick at least one model, or choose Any model.', 'error'); return; }
    var capText = $('f-cap').value.trim();
    var cap = capText === '' ? null : Number(capText);
    if (cap !== null && (!Number.isInteger(cap) || cap <= 0)) { say('The daily limit must be a whole number above zero, or left empty.', 'error'); return; }
    var save = $('f-save');
    save.disabled = true;
    var editing = state.editing;
    var req;
    if (editing) req = api('PATCH', '/admin/keys/' + encodeURIComponent(editing), { models: models, daily_token_limit: cap });
    else {
      var body = { name: $('f-name').value.trim(), models: models };
      if (cap !== null) body.daily_token_limit = cap;
      req = api('POST', '/admin/keys', body);
    }
    req.then(function (res) {
      state.adding = false; state.editing = null; keyModels.close();
      if (!editing) showSecret(res);
      say(editing ? 'Saved ' + editing + '.' : 'Created ' + res.name + '.', 'ok');
      return load();
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
  function toggleKey(k) {
    api('PATCH', '/admin/keys/' + encodeURIComponent(k.name), { disabled: !k.disabled })
      .then(function () { say((k.disabled ? 'Enabled ' : 'Disabled ') + k.name + '.', 'ok'); return load(); }).catch(fail);
  }
  function removeKey(k) {
    confirmDialog({ title: 'Delete ' + k.name + '?', body: 'Anyone using this key loses access right away. This cannot be undone.', yes: 'Delete key', no: 'Keep key' }).then(function (yes) {
      if (!yes) return;
      return api('DELETE', '/admin/keys/' + encodeURIComponent(k.name)).then(function () { say('Deleted ' + k.name + '.', 'ok'); return load(); }).catch(fail);
    });
  }
  function endLoan(k, g) {
    confirmDialog({ title: 'End ' + k.name + "'s access to " + listNames(g.models) + '?', body: k.name + ' loses it right away and goes back to their normal models.', yes: 'End access', no: 'Keep it' }).then(function (yes) {
      if (!yes) return;
      return api('DELETE', '/admin/keys/' + encodeURIComponent(k.name) + '/grants/' + encodeURIComponent(g.id))
        .then(function () { say('Ended ' + k.name + "'s access to " + listNames(g.models) + '.', 'ok'); return load(); }).catch(fail);
    });
  }

  // ---- Lend access ----
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
    el.textContent = 'Ends ' + end.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' (in ' + left(m * 60).replace(' left', '') + ').';
  }
  function openGrant(k) {
    if (state.adding || state.editing) closeForm();
    state.inviting = null;
    state.granting = k.name;
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
    renderKeys();
    $('g-models-btn').focus();
    $('grant-form').scrollIntoView({ block: 'nearest' });
  }
  function closeGrant(silent) {
    state.granting = null; grantModels.close();
    if (!silent) renderKeys();
  }
  function submitGrant(ev) {
    ev.preventDefault();
    var name = state.granting;
    if (!name) return;
    var models = grantModels.get();
    if (!models.length) { say('Choose at least one model to lend.', 'error'); return; }
    var minutes = grantMinutes();
    if (!(minutes >= 1 && minutes <= 10080)) { say('Choose how long: from 1 minute to 7 days.', 'error'); return; }
    var btn = $('g-save');
    btn.disabled = true;
    api('POST', '/admin/keys/' + encodeURIComponent(name) + '/grants', { models: models, minutes: minutes, note: $('g-note').value.trim() || undefined })
      .then(function (res) {
        state.granting = null; grantModels.close();
        say(name + ' can use ' + listNames(models) + ' for ' + left(res.grant.seconds_left).replace(' left', '') + '.', 'ok');
        return load();
      }).catch(fail).then(function () { btn.disabled = false; });
  }

  // ---- Models ----
  var modelSearch = h('input', { type: 'search', placeholder: 'Search models', 'aria-label': 'Search models', autocomplete: 'off' });
  var modelNote = h('p', { class: 'hint', text: 'Standard models are open to every key set to All standard models. On-request ones need an approved request or a loan.' });
  var syncBtn = h('button', { type: 'button', id: 'go-sync', text: 'Update OpenCode Go models' });
  var addModelBtn = h('button', { type: 'button', class: 'primary', id: 'add-model', text: 'Add model' });
  var modelsLeft = h('div', { class: 'bar-left' }, [modelSearch]);
  $('models-bar').appendChild(modelsLeft);
  $('models-bar').appendChild(h('div', { class: 'acts' }, [syncBtn, addModelBtn]));
  modelSearch.addEventListener('input', function () { state.modelFilter = modelSearch.value.trim().toLowerCase(); renderModels(); });
  addModelBtn.addEventListener('click', function () { state.addingModel = true; $('m-id').value = ''; $('m-name').value = ''; setNewAccess('on_request'); renderModels(); $('m-id').focus(); });
  syncBtn.addEventListener('click', syncGo);
  syncBtn.title = 'Adds any new OpenCode Go models: cheap ones as standard, the rest on request.';

  function setNewAccess(v) {
    state.newModelAccess = v;
    Array.prototype.forEach.call($('m-access').querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-access') === v)); });
  }
  Array.prototype.forEach.call($('m-access').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { setNewAccess(b.getAttribute('data-access')); }); });
  $('m-cancel').addEventListener('click', function () { state.addingModel = false; renderModels(); });

  function setAccess(m, value) {
    api('POST', '/admin/models', { id: m.id, name: m.name, access: value })
      .then(function () { say(plainName(m.id) + ' is now ' + (value === 'on_request' ? 'on request.' : 'standard.'), 'ok'); return load(); }).catch(fail);
  }
  function removeModel(m) {
    confirmDialog({ title: 'Remove ' + m.name + ' from the list?', body: 'Keys that already have it keep working. It just stops being offered here and in OpenCode.', yes: 'Remove model', no: 'Keep it' }).then(function (yes) {
      if (!yes) return;
      return api('DELETE', '/admin/models/' + encodeURIComponent(m.id)).then(function () { say('Removed ' + m.name + '.', 'ok'); return load(); }).catch(fail);
    });
  }
  function modelRow(m) {
    var isGo = m.id.indexOf('go/') === 0;
    var std = m.access === 'standard';
    var nameCell = h('div', { class: 'm-name' }, [h('strong', { text: isGo ? plainName(m.id) : m.name }), isGo ? h('span', { class: 'tags' }, [h('span', { class: 'chip', text: 'OpenCode Go' })]) : null]);
    var menu = rowMenu('Actions for ' + m.name, [
      { text: std ? 'Make on request' : 'Make standard', run: function () { setAccess(m, std ? 'on_request' : 'standard'); } },
      'sep',
      { text: 'Remove from list', bad: true, run: function () { removeModel(m); } }
    ]);
    return h('div', { class: 'mrow' }, [nameCell, h('span', { class: 'mono', text: m.id }), menu.el]);
  }
  function renderModelsBar() {
    var many = state.models.length > SEARCH_AFTER;
    modelSearch.hidden = !many;
    $('models-bar').hidden = !state.models.length && !state.addingModel;
    syncBtn.hidden = !(state.go && state.go.connected);
    addModelBtn.hidden = state.addingModel || !state.models.length;
  }
  function renderModels() {
    var box = $('models');
    clear(box);
    renderModelsBar();
    $('model-form').hidden = !state.addingModel;
    if (!state.models.length) {
      if (!state.addingModel) box.appendChild(h('div', { class: 'card' }, [stateBox('No models listed', 'Add the models people can use or ask for. They show up in OpenCode and in the access dropdowns.', h('button', { type: 'button', class: 'primary', text: 'Add model', onclick: function () { state.addingModel = true; renderModels(); $('m-id').focus(); } }))]));
      return;
    }
    var q = state.modelFilter;
    var shown = state.models.filter(function (m) { return !q || (m.name + ' ' + m.id).toLowerCase().indexOf(q) !== -1; });
    if (!shown.length) { box.appendChild(h('div', { class: 'card' }, [stateBox('No models match', 'Nothing is named like "' + q + '".')])); return; }
    var card = h('div', { class: 'card' });
    [['standard', 'Standard'], ['on_request', 'On request']].forEach(function (g) {
      var rows = shown.filter(function (m) { return m.access === g[0]; });
      if (!rows.length) return;
      card.appendChild(h('div', { class: 'group', text: g[1] + ' \u00b7 ' + rows.length }));
      rows.forEach(function (m) { card.appendChild(modelRow(m)); });
    });
    box.appendChild(modelNote);
    box.appendChild(card);
  }
  function syncGo() {
    syncBtn.disabled = true;
    api('POST', '/admin/go/sync')
      .then(function (res) {
        var n = res.added.length;
        say(n ? 'Added ' + plural(n, 'OpenCode Go model') + '.' : 'You already have every OpenCode Go model.', 'ok');
        return load();
      }).catch(fail).then(function () { syncBtn.disabled = false; });
  }
  $('model-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var id = $('m-id').value.trim(), name = $('m-name').value.trim();
    if (!id) { say('Enter the model id, for example claude-opus-5-5.', 'error'); return; }
    var btn = $('m-add');
    btn.disabled = true;
    api('POST', '/admin/models', { id: id, name: name || id, access: state.newModelAccess })
      .then(function () { state.addingModel = false; say('Added ' + (name || id) + '.', 'ok'); return load(); })
      .catch(fail).then(function () { btn.disabled = false; });
  });

  // ---- Usage ----
  function syncPeriod() {
    Array.prototype.forEach.call(document.querySelectorAll('.seg[aria-label=Period] button'), function (b) { b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-days')) === state.days)); });
  }
  function renderUsage() {
    var box = $('usage');
    clear(box);
    var u = state.usage;
    if (state.statsOff || !u) { box.appendChild(h('div', { class: 'card' }, [stateBox('Usage tracking is off', 'This relay is not recording who uses what, so there is nothing to show.')])); return; }
    var period = state.days === 1 ? 'today' : 'in the last ' + state.days + ' days';
    if (!u.rows.length) { box.appendChild(h('div', { class: 'card' }, [stateBox('No usage ' + period, 'Nobody has used the relay ' + period + '.')])); return; }
    var failed = {};
    u.rows.forEach(function (r) { failed[r.name] = (failed[r.name] || 0) + r.failures; });
    var people = u.by_key.slice().sort(function (a, b) { return b.tokens - a.tokens; });
    var max = Math.max.apply(null, people.map(function (p) { return p.tokens; })) || 1;
    var card = h('div', { class: 'card' });
    people.forEach(function (p) {
      var track = h('div', { class: 'track', role: 'img', 'aria-label': short(p.tokens) + ' tokens' }, [h('span')]);
      track.firstChild.style.width = Math.max(1, Math.round(p.tokens / max * 100)) + '%';
      var figs = short(p.tokens) + ' tokens \u00b7 ' + plural(p.requests, 'request') + (failed[p.name] ? ' \u00b7 ' + failed[p.name] + ' failed' : '');
      card.appendChild(h('div', { class: 'ubar' }, [h('strong', { text: p.name }), track, h('div', { class: 'figs num small', title: full(p.tokens) + ' tokens', text: figs })]));
    });
    var stack = h('div', { class: 'stack' }, [card]);
    var fold = h('details', { class: 'fold' }, [h('summary', { text: 'Day by day' })]);
    var inner = h('div', { class: 'inner' });
    inner.appendChild(h('div', { class: 'urow head' }, [h('div', { text: 'Day' }), h('div', { text: 'Key' }), h('div', { text: 'Model' }), h('div', { class: 'r', text: 'Requests' }), h('div', { class: 'r', text: 'Failed' }), h('div', { class: 'r', text: 'Tokens in' }), h('div', { class: 'r', text: 'Tokens out' })]));
    u.rows.forEach(function (r) {
      inner.appendChild(h('div', { class: 'urow' }, [
        h('div', { class: 'c-day', text: r.day }), h('div', { class: 'c-key', text: r.name }), h('div', { class: 'c-model', text: r.model }),
        h('div', { class: 'r c-req', text: full(r.requests) }), h('div', { class: 'r c-fail', text: full(r.failures) }), h('div', { class: 'r c-in', text: short(r.inputTokens) }), h('div', { class: 'r c-out', text: short(r.outputTokens) }),
        h('div', { class: 'sub num', text: plural(r.requests, 'request') + (r.failures ? ' \u00b7 ' + r.failures + ' failed' : '') + ' \u00b7 ' + short(r.inputTokens) + ' in, ' + short(r.outputTokens) + ' out' })
      ]));
    });
    fold.appendChild(inner);
    stack.appendChild(fold);
    box.appendChild(stack);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.seg[aria-label=Period] button'), function (b) {
    b.addEventListener('click', function () {
      state.days = Number(b.getAttribute('data-days'));
      urlSet({ days: state.days === 1 ? null : state.days }, true);
      syncPeriod();
      loadUsage();
    });
  });
  function loadUsage() {
    return api('GET', '/admin/usage?days=' + state.days).then(function (u) { state.usage = u; state.statsOff = false; renderUsage(); }, function (err) {
      if (err.status === 409) { state.usage = null; state.statsOff = true; renderUsage(); return; }
      throw err;
    }).catch(fail);
  }

  // ---- Loading everything ----
  function renderAll() {
    var failed = !state.loaded && state.loadError;
    $('loading').hidden = state.loaded || !!failed;
    var le = $('load-error');
    le.hidden = !failed;
    clear(le);
    if (failed) le.appendChild(stateBox("Couldn't load the dashboard", state.loadError, h('button', { type: 'button', class: 'primary', text: 'Try again', onclick: function () { load(); } }), 'error'));
    if (!state.loaded) { applyTab(); return; }
    renderRequests();
    renderKeys();
    renderModels();
    renderUsage();
    syncPeriod();
    applyTab();
  }
  function load() {
    var usageReq = api('GET', '/admin/usage?days=' + state.days).then(function (u) { return { usage: u, off: false }; }, function (err) { if (err.status === 409) return { usage: null, off: true }; throw err; });
    var goReq = api('GET', '/admin/go').catch(function (err) { if (err.status === 401) throw err; return null; });
    var reqReq = api('GET', '/admin/access-requests?status=all').catch(function (err) { if (err.status === 401) throw err; return null; });
    return Promise.all([api('GET', '/admin/keys'), usageReq, api('GET', '/admin/models'), goReq, reqReq]).then(function (res) {
      state.keys = res[0].keys;
      state.usage = res[1].usage; state.statsOff = res[1].off;
      state.models = res[2].models;
      state.go = res[3];
      state.requests = res[4] ? res[4].requests : [];
      state.loaded = true; state.loadError = null; state.lastLoad = Date.now();
      renderAll();
    }).catch(function (err) {
      if (err.status === 401) { fail(err); return; }
      if (!state.loaded) { state.loadError = err.message; renderAll(); return; }
      say(err.message, 'error');
    });
  }
  function refreshQuietly() { if (state.loaded && !$('app').hidden && Date.now() - state.lastLoad > 15000) load(); }
  window.addEventListener('focus', refreshQuietly);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshQuietly(); });

  // Loan countdowns tick on their own; one reload when a loan runs out so the row settles.
  setInterval(function () {
    var expired = false;
    Array.prototype.forEach.call(document.querySelectorAll('[data-until]'), function (el) {
      var sec = Math.round((Date.parse(el.getAttribute('data-until')) - Date.now()) / 1000);
      el.textContent = left(sec);
      if (sec <= 0) expired = true;
    });
    if (expired && !$('app').hidden) load();
    if (state.granting) updatePreview();
  }, 15000);

  function enter(username) {
    var u = urlGet();
    state.tab = u.tab; state.days = u.days;
    $('password').value = '';
    $('login').hidden = true;
    $('app').hidden = false;
    $('who').textContent = username;
    $('host').textContent = location.host;
    state.loaded = false; state.loadError = null;
    renderAll();
    load();
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
  $('signout').addEventListener('click', function () {
    api('POST', '/admin/ui/logout').catch(function () {}).then(function () { showLogin(''); });
  });
  $('f-cancel').addEventListener('click', closeForm);
  $('invite-form').addEventListener('submit', submitInvite);
  $('i-cancel').addEventListener('click', closeInvite);
  $('link-copy').addEventListener('click', copyLink);
  $('link-done').addEventListener('click', function () { $('link-value').textContent = ''; $('link-panel').hidden = true; });
  $('key-form').addEventListener('submit', submitForm);
  $('grant-form').addEventListener('submit', submitGrant);
  $('g-cancel').addEventListener('click', function () { closeGrant(false); });
  $('g-custom').addEventListener('input', updatePreview);
  $('g-unit').addEventListener('change', updatePreview);
  $('copy-btn').addEventListener('click', copySecret);
  $('secret-done').addEventListener('click', function () { $('secret-value').textContent = ''; $('secret-panel').hidden = true; });

  api('GET', '/admin/ui/session').then(function (res) { enter(res.username); }).catch(function () { showLogin(''); });
})();
`;
