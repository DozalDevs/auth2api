export const ACCOUNT_BODY = String.raw`
<div class="wrap narrow">
  <section id="login" class="login" hidden>
    <div class="card">
      <h1>DozalDevs AI Relay</h1>
      <p class="muted">Sign in to see your access.</p>
      <form id="login-form">
        <div>
          <label for="email">Email</label>
          <input id="email" type="text" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" required>
        </div>
        <div>
          <label for="password">Password</label>
          <input id="password" type="password" autocomplete="current-password" required>
        </div>
        <p id="login-error" class="hint err" role="alert"></p>
        <button id="connect" class="primary" type="submit">Sign in</button>
        <p class="hint">Forgot your password? Ask the engineering team for a new link.</p>
      </form>
    </div>
  </section>

  <section id="welcome" class="login" hidden>
    <div class="card">
      <h1>Welcome</h1>
      <p class="muted">Choose a password to finish setting up your sign-in.</p>
      <form id="welcome-form">
        <div>
          <label for="new-password">Password</label>
          <input id="new-password" type="password" autocomplete="new-password" minlength="12" required>
          <p class="hint">At least 12 characters. A few random words works well.</p>
        </div>
        <div>
          <label for="new-password2">Type it again</label>
          <input id="new-password2" type="password" autocomplete="new-password" required>
        </div>
        <p id="welcome-error" class="hint err" role="alert"></p>
        <button id="welcome-save" class="primary" type="submit">Save and continue</button>
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

    <div id="loading" class="skeleton">Loading&hellip;</div>
    <div id="load-error" class="card" hidden></div>

    <div id="page" class="stack" hidden>
      <div id="disabled-note" class="notice" hidden>Your key is switched off, so nothing works right now. Ask the engineering team.</div>

      <section id="ask" class="card section"></section>
      <section id="canuse" class="card"></section>
      <section id="requests" class="card" hidden></section>
      <section id="usage" class="card"></section>
      <details id="setup" class="fold">
        <summary>Set up OpenCode on a computer</summary>
        <div class="inner" id="setup-body"></div>
      </details>
    </div>
  </div>

  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
</div>
`;
