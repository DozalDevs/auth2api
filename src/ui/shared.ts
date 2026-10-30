export const SHARED_JS = String.raw`
  function $(id) { return document.getElementById(id); }
  function h(tag, props, kids) {
    var node = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'text') node.textContent = props[k];
      else if (k === 'class') node.className = props[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== false && props[k] !== null && props[k] !== undefined) node.setAttribute(k, props[k] === true ? '' : props[k]);
    });
    (kids || []).forEach(function (kid) { if (kid) node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid); });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---- Wording and numbers ----
  function full(n) { return Number(n).toLocaleString('en-US'); }
  function short(n) {
    n = Number(n);
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function left(sec) {
    if (sec <= 0) return 'ended';
    var m = Math.floor(sec / 60);
    if (m < 1) return 'under 1 min left';
    if (m < 60) return m + ' min left';
    var hr = Math.floor(m / 60), rest = m % 60;
    if (hr < 48) return hr + 'h' + (rest ? ' ' + rest + 'm' : '') + ' left';
    return Math.floor(hr / 24) + ' days left';
  }
  function ago(iso) {
    var sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (sec < 60) return 'just now';
    var m = Math.round(sec / 60);
    if (m < 60) return m + ' min ago';
    var hr = Math.round(m / 60);
    if (hr < 48) return hr + ' h ago';
    return Math.round(hr / 24) + ' days ago';
  }
  function when(iso) { return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function minutesText(m) {
    if (m % 1440 === 0) return plural(m / 1440, 'day');
    if (m % 60 === 0) return plural(m / 60, 'hour');
    return plural(m, 'minute');
  }

  function stateBox(title, body, action, kind) {
    var box = h('div', { class: 'state' + (kind ? ' ' + kind : '') }, [h('h2', { text: title }), body ? h('p', { text: body }) : null]);
    if (action) box.appendChild(action);
    return box;
  }


  var toastTimer = null;
  function say(msg, kind) {
    var el = $('toast');
    clearTimeout(toastTimer);
    clear(el);
    if (!msg) { el.hidden = true; return; }
    el.className = 'toast' + (kind === 'error' ? ' error' : '');
    el.appendChild(h('span', { text: msg }));
    if (kind === 'error') el.appendChild(h('button', { type: 'button', text: 'Dismiss', onclick: function () { say(''); } }));
    el.hidden = false;
    if (kind !== 'error') toastTimer = setTimeout(function () { say(''); }, 5000);
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
`;
