import { SHARED_JS } from "./shared";

export const ACCOUNT_JS = String.raw`
(function () {
  'use strict';
  var LENGTHS = [60, 120, 240, 480, 1440];
  var state = { me: null, loaded: false, loadError: null, lastLoad: 0, asking: false, preset: null, usageOpen: false, setup: null };

  ${SHARED_JS}

  function nameOf(id) {
    var ms = state.me ? state.me.models : [];
    for (var i = 0; i < ms.length; i++) if (ms[i].id.toLowerCase() === String(id).toLowerCase()) return ms[i].name;
    return id;
  }
  function listNames(ids) {
    var n = ids.map(nameOf);
    return n.length <= 1 ? n.join('') : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
  }
  function showLogin(message) {
    $('app').hidden = true;
    $('welcome').hidden = true;
    $('login').hidden = false;
    $('login-error').textContent = message || '';
    $('password').value = '';
    $('email').focus();
  }
  function fail(err) {
    if (err.status === 401) { state.loaded = false; showLogin('Your session ended. Sign in again.'); return; }
    say(err.message, 'error');
  }

  // ---- Ask for a model ----
  function askable() {
    var all = (state.me ? state.me.models : []).filter(function (m) { return m.state === 'ask' && !m.pending_request; });
    return all.sort(function (a, b) { return (a.access === b.access ? 0 : a.access === 'on_request' ? -1 : 1) || a.name.localeCompare(b.name); });
  }
  function renderAsk() {
    var box = $('ask');
    clear(box);
    var me = state.me;
    if (me.key.disabled) return;
    var options = askable();
    var top = h('div', { class: 'askrow' }, [h('div', {}, [h('h2', { text: 'Need another model?' }), h('p', { class: 'muted sub', text: options.length ? 'Ask for it and say why. Someone on the engineering team will answer here.' : (me.models.some(function (m) { return m.state === 'ask'; }) ? 'You have asked for everything else already. Answers show below.' : 'You can already use every model on the list.') })])]);
    var open = h('button', { type: 'button', class: 'primary', id: 'ask-open', text: 'Ask for a model' });
    if (options.length && !state.asking) top.appendChild(open);
    box.appendChild(top);
    open.addEventListener('click', function () { state.asking = true; state.preset = null; renderAsk(); $('ask-model').focus(); });
    if (!options.length || !state.asking) return;

    var sel = h('select', { id: 'ask-model', 'aria-label': 'Model' });
    var groups = [['on_request', 'On request'], ['standard', 'Not on your key yet']];
    groups.forEach(function (g) {
      var inGroup = options.filter(function (m) { return m.access === g[0]; });
      if (!inGroup.length) return;
      var og = h('optgroup', { label: g[1] });
      inGroup.forEach(function (m) { og.appendChild(h('option', { value: m.id, text: m.name })); });
      sel.appendChild(og);
    });
    if (state.preset && options.some(function (m) { return m.id === state.preset; })) sel.value = state.preset;
    var why = h('textarea', { id: 'ask-why', maxlength: '500', placeholder: 'What will you use it for? The person approving reads this.', 'aria-describedby': 'ask-why-hint' });
    var whyHint = h('p', { id: 'ask-why-hint', class: 'hint', text: 'Required.' });
    var len = h('select', { id: 'ask-length', 'aria-label': 'For how long' });
    LENGTHS.forEach(function (m) { len.appendChild(h('option', { value: String(m), text: minutesText(m) })); });
    len.value = '240';
    var send = h('button', { type: 'submit', class: 'primary', id: 'ask-send', text: 'Send request' });
    var cancel = h('button', { type: 'button', text: 'Cancel', onclick: function () { state.asking = false; renderAsk(); } });
    var form = h('form', { class: 'askform', id: 'ask-form' }, [
      h('div', { class: 'two' }, [h('div', {}, [h('label', { for: 'ask-model', text: 'Which model' }), sel]), h('div', {}, [h('label', { for: 'ask-length', text: 'For how long' }), len])]),
      h('div', {}, [h('label', { for: 'ask-why', text: 'Why do you need it?' }), why, whyHint]),
      h('div', { class: 'actions' }, [send, cancel])
    ]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var reason = why.value.trim();
      if (!reason) { whyHint.textContent = 'Say why you need it, in a sentence.'; whyHint.className = 'hint err'; why.focus(); return; }
      send.disabled = true;
      api('POST', '/account/api/requests', { model: sel.value, reason: reason, minutes: Number(len.value) })
        .then(function (res) {
          state.asking = false;
          say('Sent. You will see the answer here.', 'ok');
          return load();
        }).catch(function (err) { fail(err); send.disabled = false; });
    });
    box.appendChild(form);
  }

  // ---- What you can use ----
  function renderCanUse() {
    var box = $('canuse');
    clear(box);
    var allowed = state.me.models.filter(function (m) { return m.state === 'allowed'; });
    var loans = allowed.filter(function (m) { return m.loan; });
    var head = h('div', { class: 'section' }, [h('h2', { text: allowed.length ? 'You can use ' + plural(allowed.length, 'model') : 'You cannot use any model yet' })]);
    if (loans.length) {
      var pills = h('div', { class: 'pilllist' });
      loans.forEach(function (m) {
        pills.appendChild(h('div', { class: 'loan', title: 'Lent to you for a short time' }, [h('span', { text: m.name }), h('span', { class: 'left', 'data-until': m.loan.until, text: left(m.loan.seconds_left) })]));
      });
      head.appendChild(pills);
    }
    box.appendChild(head);
    if (allowed.length) {
      var fold = h('details', { class: 'fold flush', id: 'all-models' }, [h('summary', { text: 'Show all ' + allowed.length })]);
      var names = h('div', { class: 'names' });
      allowed.forEach(function (m) { names.appendChild(h('span', { class: 'chip', text: m.name })); });
      fold.appendChild(names);
      box.appendChild(fold);
    }
  }

  // ---- Your requests ----
  function cancelRequest(id, btn) {
    btn.disabled = true;
    api('DELETE', '/account/api/requests/' + encodeURIComponent(id))
      .then(function () { say('Request cancelled.', 'ok'); return load(); }).catch(function (err) { fail(err); btn.disabled = false; });
  }
  function renderRequests() {
    var box = $('requests');
    clear(box);
    var all = state.me.requests.filter(function (r) { return r.status !== 'cancelled'; });
    box.hidden = !all.length;
    if (!all.length) return;
    box.appendChild(h('div', { class: 'section' }, [h('h2', { text: 'Your requests' })]));
    all.slice(0, 6).forEach(function (r) {
      var line, meta;
      if (r.status === 'pending') {
        line = h('div', {}, [h('strong', { text: listNames(r.models) }), h('span', { class: 'chip waiting', text: 'Waiting for approval' })]);
        meta = 'Asked ' + ago(r.requested_at);
      } else if (r.status === 'approved') {
        line = h('div', {}, [h('strong', { text: listNames(r.models) }), h('span', { class: 'verdict yes', text: ' \u00b7 Approved' })]);
        meta = (r.seconds_left > 0 ? left(r.seconds_left) : 'Ended') + (r.decision_note ? ' \u00b7 ' + r.decision_note : '');
      } else {
        line = h('div', {}, [h('strong', { text: listNames(r.models) }), h('span', { class: 'verdict no', text: ' \u00b7 Not approved' })]);
        meta = r.decision_note || 'No reason given';
      }
      var row = h('div', { class: 'myreq' }, [h('div', {}, [line, h('div', { class: 'meta', text: meta })])]);
      if (r.status === 'pending') {
        var cancel = h('button', { type: 'button', class: 'link', text: 'Cancel request', 'aria-label': 'Cancel the request for ' + listNames(r.models) });
        cancel.addEventListener('click', function () { cancelRequest(r.id, cancel); });
        row.appendChild(cancel);
      }
      box.appendChild(row);
    });
  }

  // ---- Usage ----
  function renderUsage() {
    var box = $('usage');
    clear(box);
    var me = state.me;
    if (me.tokens_today === null) { box.hidden = true; return; }
    box.hidden = false;
    var limit = me.daily_token_limit;
    var sec = h('div', { class: 'section' }, [h('h2', { text: 'Your usage' })]);
    var line = limit
      ? h('p', { class: 'num', title: full(me.tokens_today) + ' of ' + full(limit) + ' tokens today' }, [h('span', { class: 'big', text: short(me.tokens_today) }), ' of ' + short(limit) + ' tokens used today'])
      : h('p', { class: 'num', title: full(me.tokens_today) + ' tokens today' }, [h('span', { class: 'big', text: short(me.tokens_today) }), ' tokens used today, no daily limit']);
    sec.appendChild(line);
    if (limit) {
      var pct = Math.min(100, Math.round(me.tokens_today / limit * 100));
      var level = me.tokens_today >= limit ? 'over' : pct >= 80 ? 'near' : '';
      var meter = h('div', { class: 'meter ' + level, role: 'img', 'aria-label': pct + ' percent of your daily limit used' }, [h('span')]);
      meter.firstChild.style.width = pct + '%';
      sec.appendChild(meter);
      if (level === 'over') sec.appendChild(h('p', { class: 'err small', text: 'You have reached your daily limit. It starts again at midnight UTC.' }));
      else if (level === 'near') sec.appendChild(h('p', { class: 'small', text: 'You are close to your daily limit.' }));
    }
    box.appendChild(sec);
    var days = me.usage ? me.usage.days : [];
    if (days.length) {
      var fold = h('details', { class: 'fold flush' }, [h('summary', { text: 'Last 7 days' })]);
      if (state.usageOpen) fold.open = true;
      fold.addEventListener('toggle', function () { state.usageOpen = fold.open; });
      days.forEach(function (d) { fold.appendChild(h('div', { class: 'dayrow num' }, [h('span', { text: d.day }), h('span', { text: short(d.tokens) + ' tokens \u00b7 ' + plural(d.requests, 'request') })])); });
      box.appendChild(fold);
    }
  }

  // ---- Set up ----
  function copyBox(label, text) {
    var code = h('code', { class: 'code', text: text });
    var btn = h('button', { type: 'button', class: 'quiet', text: 'Copy' });
    btn.addEventListener('click', function () {
      var done = function () { btn.textContent = 'Copied'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { selectText(code); });
      else selectText(code);
    });
    return h('div', { class: 'copybox' }, [h('div', { class: 'copytop' }, [h('span', { class: 'label', text: label }), btn]), code]);
  }
  function selectText(node) {
    var range = document.createRange(); range.selectNodeContents(node);
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    say('Press Ctrl+C or Cmd+C to copy.', 'ok');
  }
  function setupCommands(code) {
    return {
      mac: 'curl -fsSL ' + location.origin + '/setup/opencode.sh | RELAY_SETUP_CODE=' + code + ' bash',
      win: "$env:RELAY_SETUP_CODE='" + code + "'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((irm " + location.origin + '/setup/opencode.ps1)))'
    };
  }
  function getSetupCode(btn) {
    btn.disabled = true;
    api('POST', '/account/api/setup-code')
      .then(function (res) { state.setup = res; renderSetup(); })
      .catch(function (err) { fail(err); btn.disabled = false; });
  }
  function renderSetup() {
    var body = $('setup-body');
    clear(body);
    body.appendChild(h('p', { class: 'muted intro', text: 'First install OpenCode from opencode.ai/download. Then get your command, open a terminal and paste it. It sets everything up, so you never have to type or copy your key.' }));
    var get = h('button', { type: 'button', id: 'setup-get', class: state.setup ? 'quiet' : 'primary', text: state.setup ? 'Get a new command' : 'Get my setup command' });
    get.addEventListener('click', function () { getSetupCode(get); });
    body.appendChild(h('div', { class: 'copybox' }, [get]));
    if (!state.setup) return;
    var cmds = setupCommands(state.setup.code);
    body.appendChild(copyBox('Mac or Linux', cmds.mac));
    body.appendChild(copyBox('Windows (PowerShell)', cmds.win));
    body.appendChild(h('p', { class: 'hint intro', id: 'setup-note', text: 'It works once and only until ' + new Date(state.setup.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '. Keep it to yourself like a password.' }));
  }

  // ---- Everything ----
  function renderAll() {
    var failed = !state.loaded && state.loadError;
    $('loading').hidden = state.loaded || !!failed;
    var le = $('load-error');
    le.hidden = !failed;
    clear(le);
    if (failed) le.appendChild(stateBox("Couldn't load your page", state.loadError, h('button', { type: 'button', class: 'primary', text: 'Try again', onclick: function () { load(); } }), 'error'));
    $('page').hidden = !state.loaded;
    if (!state.loaded) return;
    $('disabled-note').hidden = !state.me.key.disabled;
    renderAsk();
    renderCanUse();
    renderRequests();
    renderUsage();
    renderSetup();
  }
  function load() {
    return api('GET', '/account/api/me').then(function (me) {
      state.me = me; state.loaded = true; state.loadError = null; state.lastLoad = Date.now();
      if (state.preset && !state.asking && me.models.some(function (m) { return m.id === state.preset && m.state === 'ask' && !m.pending_request; })) state.asking = true;
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
  setInterval(function () {
    var expired = false;
    Array.prototype.forEach.call(document.querySelectorAll('[data-until]'), function (el) {
      var sec = Math.round((Date.parse(el.getAttribute('data-until')) - Date.now()) / 1000);
      el.textContent = left(sec);
      if (sec <= 0) expired = true;
    });
    if (expired && !$('app').hidden) load();
  }, 15000);

  function enter(email) {
    $('login').hidden = true;
    $('welcome').hidden = true;
    $('app').hidden = false;
    $('who').textContent = email;
    $('host').textContent = location.host + ' \u00b7 your access';
    var preset = new URLSearchParams(location.search).get('ask');
    state.preset = preset || null;
    state.loaded = false; state.loadError = null;
    renderAll();
    load();
  }

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var email = $('email').value.trim(), password = $('password').value;
    if (!email || !password) return;
    $('login-error').textContent = '';
    $('connect').disabled = true;
    api('POST', '/account/api/login', { email: email, password: password })
      .then(function (res) { enter(res.email); })
      .catch(function (err) { $('login-error').textContent = err.message; $('password').value = ''; })
      .then(function () { $('connect').disabled = false; });
  });
  var inviteToken = null;
  $('welcome-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var p1 = $('new-password').value, p2 = $('new-password2').value;
    $('welcome-error').textContent = '';
    if (p1.length < 12) { $('welcome-error').textContent = 'Use at least 12 characters.'; return; }
    if (p1 !== p2) { $('welcome-error').textContent = 'The two passwords are different.'; return; }
    $('welcome-save').disabled = true;
    api('POST', '/account/api/accept', { token: inviteToken, password: p1 })
      .then(function (res) {
        inviteToken = null;
        history.replaceState(null, '', location.pathname + location.search);
        $('new-password').value = ''; $('new-password2').value = '';
        enter(res.email);
      })
      .catch(function (err) { $('welcome-error').textContent = err.message; })
      .then(function () { $('welcome-save').disabled = false; });
  });
  $('signout').addEventListener('click', function () {
    api('POST', '/account/api/logout').catch(function () {}).then(function () { state.loaded = false; showLogin(''); });
  });

  var m = /^#invite=([A-Za-z0-9_-]{20,200})$/.exec(location.hash);
  if (m) {
    inviteToken = m[1];
    $('login').hidden = true;
    $('welcome').hidden = false;
    $('new-password').focus();
  } else {
    api('GET', '/account/api/session').then(function (res) { enter(res.email); }).catch(function () { showLogin(''); });
  }
})();
`;
