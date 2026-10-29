export const BODY = String.raw`
<div class="wrap">
  <section id="login" class="login" hidden>
    <div class="card">
      <h1>DozalDevs AI Relay</h1>
      <p class="muted">Sign in to manage keys and access.</p>
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
        <h1>DozalDevs AI Relay</h1>
        <p id="host" class="host"></p>
      </div>
      <div class="who">
        <span id="who"></span>
        <button id="signout" class="link" type="button">Sign out</button>
      </div>
    </header>

    <nav class="tabs" role="tablist" aria-label="Sections">
      <button id="tab-requests" class="tab" type="button" role="tab" aria-controls="panel-requests" data-tab="requests">Requests <span id="req-count" class="count" hidden></span></button>
      <button id="tab-keys" class="tab" type="button" role="tab" aria-controls="panel-keys" data-tab="keys">Keys</button>
      <button id="tab-models" class="tab" type="button" role="tab" aria-controls="panel-models" data-tab="models">Models</button>
      <button id="tab-usage" class="tab" type="button" role="tab" aria-controls="panel-usage" data-tab="usage">Usage</button>
    </nav>

    <div id="loading" class="skeleton">Loading&hellip;</div>
    <div id="load-error" class="card" hidden></div>

    <section id="panel-requests" role="tabpanel" aria-labelledby="tab-requests" hidden>
      <div id="requests"></div>
    </section>

    <section id="panel-keys" role="tabpanel" aria-labelledby="tab-keys" hidden>
      <div id="secret-panel" class="secret-box" hidden>
        <h2>Key for <span id="secret-name"></span></h2>
        <div class="secret-top">
          <span class="muted">Copy it now. It is only shown this once.</span>
          <button id="copy-btn" class="primary quiet" type="button">Copy key</button>
        </div>
        <code id="secret-value" class="secret"></code>
        <div class="actions"><button id="secret-done" type="button">Done</button></div>
      </div>

      <div id="keys-bar" class="bar"></div>
      <div id="keys"></div>
    </section>

    <section id="panel-models" role="tabpanel" aria-labelledby="tab-models" hidden>
      <div id="models-bar" class="bar"></div>
      <form id="model-form" class="formcard" hidden>
        <h2>Add a model</h2>
        <div class="fields">
          <div>
            <label for="m-id">Model id</label>
            <input id="m-id" type="text" placeholder="claude-opus-5-5" autocomplete="off" spellcheck="false">
          </div>
          <div>
            <label for="m-name">Name people see</label>
            <input id="m-name" type="text" maxlength="80" placeholder="Claude Opus 5.5" autocomplete="off">
          </div>
          <div>
            <span class="label" id="m-access-label">Who gets it</span>
            <div id="m-access" class="seg" role="group" aria-labelledby="m-access-label">
              <button type="button" data-access="on_request" aria-pressed="true">On request</button>
              <button type="button" data-access="standard" aria-pressed="false">Standard</button>
            </div>
          </div>
        </div>
        <div class="actions">
          <button id="m-add" class="primary" type="submit">Add model</button>
          <button id="m-cancel" type="button">Cancel</button>
        </div>
      </form>
      <div id="models"></div>
    </section>

    <section id="panel-usage" role="tabpanel" aria-labelledby="tab-usage" hidden>
      <div class="bar">
        <div class="seg" role="group" aria-label="Period">
          <button type="button" data-days="1" aria-pressed="true">Today</button>
          <button type="button" data-days="7" aria-pressed="false">7 days</button>
          <button type="button" data-days="30" aria-pressed="false">30 days</button>
        </div>
      </div>
      <div id="usage"></div>
    </section>

    <div id="form-holder" hidden>
      <form id="key-form" class="formcard">
        <h2 id="form-title"></h2>
        <p id="f-suffix" class="hint form-sub" hidden></p>
        <div class="fields">
          <div id="f-name-wrap">
            <label for="f-name">Name</label>
            <input id="f-name" type="text" required maxlength="63" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" placeholder="maria" autocomplete="off">
            <p class="hint">Letters, numbers, dot, dash or underscore. Usage reports show this name.</p>
          </div>
          <div>
            <label id="f-models-label">Models this key can use</label>
            <div id="f-models-slot"></div>
            <p id="f-any-hint" class="hint" hidden>A key with any model has nothing left to lend. Pick standard models to be able to give it extra access for a few hours.</p>
          </div>
          <div id="f-cap-wrap">
            <label for="f-cap">Daily limit</label>
            <input id="f-cap" type="number" min="1" step="1" inputmode="numeric" placeholder="No limit">
            <p class="hint">Tokens per day, counted from midnight UTC. Leave empty for no limit.</p>
          </div>
        </div>
        <div class="actions">
          <button id="f-save" class="primary" type="submit">Create key</button>
          <button id="f-cancel" type="button">Cancel</button>
        </div>
      </form>

      <form id="grant-form" class="formcard">
        <h2 id="grant-title"></h2>
        <div class="fields">
          <div>
            <label id="g-models-label">Models to lend</label>
            <div id="g-models-slot"></div>
          </div>
          <div>
            <span class="label" id="g-for-label">For how long</span>
            <div id="g-presets" class="seg" role="group" aria-labelledby="g-for-label"></div>
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
            <label for="g-note">Why <span class="muted">(optional)</span></label>
            <input id="g-note" type="text" maxlength="200" placeholder="For example: dashboard redesign" autocomplete="off">
          </div>
        </div>
        <div class="actions">
          <button id="g-save" class="primary" type="submit">Give access</button>
          <button id="g-cancel" type="button">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <dialog id="confirm" aria-labelledby="confirm-title">
    <h2 id="confirm-title"></h2>
    <p id="confirm-body"></p>
    <div class="actions">
      <button id="confirm-no" type="button"></button>
      <button id="confirm-yes" class="danger" type="button"></button>
    </div>
  </dialog>

  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
</div>
`;
