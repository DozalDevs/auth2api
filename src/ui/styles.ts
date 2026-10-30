export const CSS = String.raw`
:root {
  --bg: #f6f5f1; --panel: #ffffff; --text: #1c211f; --muted: #58625d; --line: #e4e2dc; --line-strong: #cbc8c0; --control: #858a84; --danger-text: #ffffff;
  --accent: #0e6a5c; --accent-text: #ffffff; --accent-soft: #e2efec; --danger: #b3261e; --danger-soft: #fbebe9;
  --warn: #8f5100; --chip: #edebe5; --focus: #0e6a5c; --backdrop: rgba(20, 24, 22, .45);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101412; --panel: #171c1a; --text: #e9eeeb; --muted: #9aa7a1; --line: #29312e; --line-strong: #3b4642; --control: #6b7873; --danger-text: #2a0805;
    --accent: #4fc4ae; --accent-text: #06231e; --accent-soft: #1a2b27; --danger: #ff9086; --danger-soft: #2d1b19;
    --warn: #f0b35a; --chip: #212825; --focus: #4fc4ae; --backdrop: rgba(0, 0, 0, .6);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
h1, h2, h3, p { margin: 0; }
[hidden] { display: none !important; }
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.num { font-variant-numeric: tabular-nums; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 20px 20px 120px; }

button { min-height: 38px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--panel); cursor: pointer; font-weight: 500; white-space: nowrap; }
button:hover:not(:disabled) { border-color: var(--muted); }
button:disabled { opacity: .5; cursor: not-allowed; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
button.primary:hover:not(:disabled) { filter: brightness(1.08); border-color: var(--accent); }
button.danger { background: var(--danger); border-color: var(--danger); color: var(--danger-text); font-weight: 600; }
button.link { min-height: 0; padding: 2px 0; border: 0; background: none; color: var(--accent); font-weight: 500; text-decoration: underline; text-underline-offset: 3px; }
button.link:hover:not(:disabled) { border: 0; filter: brightness(.85); }
button.quiet { min-height: 34px; padding: 0 12px; font-size: 14px; }

input[type=text], input[type=password], input[type=number], input[type=search] { width: 100%; min-height: 40px; padding: 0 12px; border: 1px solid var(--control); border-radius: 8px; background: var(--panel); }
input::placeholder { color: var(--muted); opacity: 1; }
select { min-height: 40px; padding: 0 10px; border: 1px solid var(--control); border-radius: 8px; background: var(--panel); }
label, .label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 6px; }
.hint { color: var(--muted); font-size: 13px; margin-top: 6px; }
.err { color: var(--danger); }

.top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 4px 0 18px; }
.top h1 { font-size: 22px; line-height: 1.2; font-weight: 700; letter-spacing: -.01em; }
.top .host { font-size: 13px; color: var(--muted); margin-top: 2px; overflow-wrap: anywhere; }
.whoacts { display: flex; gap: 14px; align-items: center; }
.whoacts .link[aria-current=page] { font-weight: 700; text-decoration-thickness: 2px; }
.who { display: flex; align-items: center; gap: 12px; font-size: 14px; color: var(--muted); flex-wrap: wrap; justify-content: flex-end; text-align: right; }

.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 20px; overflow-x: auto; scrollbar-width: none; }
.tabs::-webkit-scrollbar { display: none; }
.tab { min-height: 46px; padding: 0 14px; border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: none; color: var(--muted); font-weight: 600; font-size: 15px; display: inline-flex; align-items: center; gap: 8px; margin-bottom: -1px; }
.tab:hover:not(:disabled) { border-color: transparent; border-bottom-color: var(--line-strong); color: var(--text); }
.tab[aria-selected=true] { color: var(--text); border-bottom-color: var(--accent); }
.count { min-width: 22px; height: 22px; padding: 0 7px; border-radius: 999px; background: var(--accent); color: var(--accent-text); font-size: 12.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }

.card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; container-type: inline-size; }
.card + .card, .bar + .card, .card + .fold, .stack > * + * { margin-top: 12px; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; min-height: 40px; }
.bar-left { flex: 1 1 220px; min-width: 0; display: flex; align-items: center; gap: 12px; max-width: 420px; }
.bar-left.counting { max-width: none; }
.bar .acts { display: flex; gap: 8px; flex-wrap: wrap; }
.bar .title { font-weight: 600; }
.bar .acts { margin-left: auto; }
.group { font-size: 13px; font-weight: 600; color: var(--muted); padding: 14px 18px 6px; border-top: 1px solid var(--line); }
.group:first-child { border-top: 0; }

.state { padding: 44px 20px; text-align: center; }
.state h2 { font-size: 17px; font-weight: 650; margin-bottom: 6px; }
.state p { color: var(--muted); max-width: 46ch; margin: 0 auto 16px; }
.state p:last-child { margin-bottom: 0; }
.state.error h2 { color: var(--danger); }
.skeleton { padding: 20px 18px; color: var(--muted); }

.chip { display: inline-flex; align-items: center; background: var(--chip); border-radius: 6px; padding: 1px 8px; font-size: 12.5px; font-weight: 500; color: var(--muted); width: fit-content; white-space: nowrap; }
.chip.strong { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.chip.off { background: var(--danger-soft); color: var(--danger); font-weight: 600; }

.krow, .mrow { padding: 14px 18px; border-top: 1px solid var(--line); }
.krow:first-child, .mrow:first-child { border-top: 0; }
.krow.head { padding-top: 10px; padding-bottom: 10px; font-size: 13px; font-weight: 600; color: var(--muted); border-top: 0; border-bottom: 1px solid var(--line); }
.krow-main { display: grid; grid-template-columns: minmax(130px, 1.1fr) minmax(0, 2.3fr) minmax(130px, 1fr) 124px 38px; gap: 8px 16px; align-items: center; }
.k-primary button { width: 100%; }
.krow-main > * { min-width: 0; }
.krow.dim .k-name strong { color: var(--muted); }
.k-name strong { display: block; font-weight: 650; overflow-wrap: anywhere; }
.k-name .chips { margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
.k-access { color: var(--text); }
.k-access .sum { overflow-wrap: anywhere; }
.loans { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.loan { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13.5px; background: var(--accent-soft); border-radius: 8px; padding: 4px 6px 4px 10px; width: fit-content; max-width: 100%; }
.loan .left { color: var(--accent); font-weight: 650; white-space: nowrap; }
.loan button { min-height: 28px; padding: 0 10px; font-size: 13px; }
.k-use .line { font-size: 14px; }
.k-use .over { color: var(--danger); font-weight: 600; font-size: 13px; }
.k-use .near { color: var(--warn); font-weight: 600; font-size: 13px; }
.meter { height: 6px; background: var(--chip); border-radius: 999px; overflow: hidden; margin-top: 6px; max-width: 180px; }
.meter > span { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
.meter.near > span { background: var(--warn); }
.meter.over > span { background: var(--danger); }

.rmenu { position: relative; }
.kebab { width: 38px; padding: 0; font-size: 18px; line-height: 1; font-weight: 700; letter-spacing: 1px; }
.menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; min-width: 200px; background: var(--panel); border: 1px solid var(--line-strong); border-radius: 10px; padding: 6px; box-shadow: 0 8px 24px rgba(0, 0, 0, .14); }
.menu button { display: block; width: 100%; text-align: left; border: 0; background: none; min-height: 40px; padding: 0 12px; border-radius: 6px; font-weight: 500; }
.menu button:hover, .menu button:focus-visible { background: var(--chip); }
.menu button.bad { color: var(--danger); }
.menu hr { border: 0; border-top: 1px solid var(--line); margin: 6px 4px; }

.meter-wrap { display: block; }
.formcard { border: 1px solid var(--line-strong); background: var(--panel); border-radius: 14px; padding: 18px; margin: 0 0 12px; }
.krow + .formcard { margin: 0 18px 14px; }
.formcard h2 { font-size: 17px; font-weight: 650; margin-bottom: 14px; }
.formcard h2 + .form-sub { margin: -8px 0 14px; }
.fields { display: grid; gap: 16px; max-width: 640px; }
.fields.cols { grid-template-columns: 1fr 1fr; max-width: none; }
.field-wide { grid-column: 1 / -1; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 18px; }
.secret-box { border: 1px solid var(--line-strong); background: var(--panel); border-radius: 14px; padding: 18px; margin-bottom: 12px; border-left: 4px solid var(--accent); }
.secret-box h2 { font-size: 17px; font-weight: 650; }
.secret-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 10px 0 10px; }
.secret { display: block; width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; word-break: break-all; background: var(--chip); border: 1px solid var(--line); border-radius: 8px; padding: 12px; user-select: all; }

.seg { display: inline-flex; border: 1px solid var(--control); border-radius: 8px; overflow: hidden; background: var(--panel); flex-wrap: wrap; }
.seg button { border: 0; border-radius: 0; min-height: 38px; background: none; }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed=true] { background: var(--accent); color: var(--accent-text); font-weight: 600; }
.dur-custom { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
.dur-custom input { width: 110px; }
.preview { margin-top: 10px; font-size: 14px; color: var(--accent); font-weight: 600; min-height: 21px; }

.ms { position: relative; }
.ms-btn { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; padding: 0 12px; min-height: 42px; background: var(--panel); font-weight: 400; border-color: var(--control); }
.ms-btn[aria-expanded=true] { border-color: var(--accent); }
.ms-caret { color: var(--muted); }
.ms-panel { margin-top: 6px; max-height: 340px; overflow: auto; background: var(--panel); border: 1px solid var(--line-strong); border-radius: 10px; padding: 8px; }
.ms-search { margin-bottom: 6px; }
.ms-row { font-weight: 400; display: flex; align-items: center; gap: 10px; margin: 0; min-height: 42px; padding: 0 8px; border-radius: 6px; cursor: pointer; font-size: 15px; }
.ms-row:hover { background: var(--chip); }
.ms-row input { flex: none; width: 18px; height: 18px; accent-color: var(--accent); }
.ms-name { flex: 1; overflow-wrap: anywhere; }
.ms-id { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; text-align: right; }
.ms-any { border-bottom: 1px solid var(--line); border-radius: 6px 6px 0 0; margin-bottom: 4px; font-weight: 600; }
.ms-empty { color: var(--muted); padding: 8px; }
.ms-foot { display: flex; justify-content: space-between; gap: 8px; padding-top: 8px; margin-top: 4px; border-top: 1px solid var(--line); }
.ms-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ms-chips .chip { padding: 2px 4px 2px 10px; gap: 2px; }
.chip-x { min-height: 0; height: 22px; width: 22px; padding: 0; border: 0; background: transparent; color: var(--muted); line-height: 1; border-radius: 999px; font-size: 16px; }
.chip-x:hover:not(:disabled) { color: var(--danger); border: 0; }

.rq { padding: 18px; }
.rq-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.rq-top strong { font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
.rq-what { margin-top: 2px; font-size: 16px; overflow-wrap: anywhere; }
.rq-why { margin-top: 12px; padding: 10px 14px; border-left: 3px solid var(--line-strong); background: var(--chip); border-radius: 0 8px 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 15.5px; }
.rq-acts { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 14px; }
.rq-more { display: grid; grid-template-columns: minmax(150px, 220px) 1fr; gap: 12px; margin-top: 12px; }
.fold { border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
.fold > summary { cursor: pointer; padding: 14px 18px; font-weight: 600; list-style: none; display: flex; align-items: center; gap: 8px; border-radius: 14px; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary::before { content: ""; width: 7px; height: 7px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(-45deg); margin-right: 4px; }
.fold[open] > summary::before { transform: rotate(45deg); }
.fold .inner { border-top: 1px solid var(--line); }
.done { padding: 12px 18px; border-top: 1px solid var(--line); font-size: 14.5px; }
.done:first-child { border-top: 0; }
.done .meta { color: var(--muted); font-size: 13px; margin-top: 2px; overflow-wrap: anywhere; }
.verdict { font-weight: 650; }
.verdict.no { color: var(--danger); }
.verdict.yes { color: var(--accent); }

.mrow { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) 38px; gap: 4px 16px; align-items: center; min-height: 50px; }
.mrow .mono { color: var(--muted); overflow-wrap: anywhere; }
.m-name strong { font-weight: 600; overflow-wrap: anywhere; }
.m-name .tags { display: inline-flex; margin-left: 8px; vertical-align: 1px; }

.ubar { display: grid; grid-template-columns: minmax(130px, 1fr) minmax(0, 3fr) 270px; gap: 8px 16px; align-items: center; padding: 12px 18px; border-top: 1px solid var(--line); }
.ubar:first-child { border-top: 0; }
.ubar strong { font-weight: 600; overflow-wrap: anywhere; }
.ubar .track { height: 10px; background: var(--chip); border-radius: 999px; overflow: hidden; }
.ubar .track > span { display: block; height: 100%; background: var(--accent); border-radius: 999px; min-width: 3px; }
.ubar .figs { text-align: right; }
.urow { display: grid; grid-template-columns: 100px minmax(110px, 1.2fr) minmax(120px, 1.6fr) 90px 80px 90px 90px; gap: 8px 14px; padding: 10px 18px; border-top: 1px solid var(--line); font-size: 14px; align-items: baseline; }
.urow.head { color: var(--muted); font-size: 13px; font-weight: 600; border-top: 0; border-bottom: 1px solid var(--line); }
.urow .r { text-align: right; font-variant-numeric: tabular-nums; }
.urow > * { min-width: 0; overflow-wrap: anywhere; }
.urow .sub { display: none; }

.login { max-width: 400px; margin: 14vh auto 0; }
.login .card { padding: 28px; container-type: normal; }
.login h1 { font-size: 22px; font-weight: 700; }
.login p.muted { margin: 4px 0 20px; }
.login form > * + * { margin-top: 14px; }
.login button { width: 100%; min-height: 44px; }

dialog { border: 1px solid var(--line-strong); border-radius: 14px; background: var(--panel); color: var(--text); padding: 22px; max-width: min(440px, calc(100vw - 32px)); width: 100%; }
dialog::backdrop { background: var(--backdrop); }
dialog h2 { font-size: 17px; font-weight: 650; margin-bottom: 8px; }
dialog p { color: var(--muted); margin-bottom: 18px; overflow-wrap: anywhere; }
dialog .actions { justify-content: flex-end; margin-top: 0; }

.toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 50; max-width: min(560px, calc(100vw - 32px)); display: flex; align-items: center; gap: 12px; background: var(--text); color: var(--bg); padding: 12px 16px; border-radius: 10px; font-weight: 500; box-shadow: 0 8px 28px rgba(0, 0, 0, .25); }
.toast.error { background: var(--danger); color: var(--danger-text); }
.toast button { min-height: 28px; padding: 0 8px; background: transparent; color: inherit; border-color: currentColor; font-size: 13px; }
@media (prefers-reduced-motion: no-preference) {
  .toast { animation: rise .18s ease-out; }
  @keyframes rise { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
}

@container (max-width: 899px) {
  .krow.head { display: none; }
  .krow-main { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.7fr) 124px 38px; }
  .krow-main .k-name { grid-column: 1; grid-row: 1 / span 2; }
  .krow-main .k-access { grid-column: 2; grid-row: 1; }
  .krow-main .k-use { grid-column: 2; grid-row: 2; }
  .krow-main .k-primary { grid-column: 3; grid-row: 1 / span 2; }
  .krow-main .rmenu { grid-column: 4; grid-row: 1 / span 2; }
}
@container (max-width: 599px) {
  .krow-main { grid-template-columns: minmax(0, 1fr) auto 38px; }
  .krow-main .k-name { grid-column: 1; grid-row: 1; }
  .krow-main .k-primary { grid-column: 2; grid-row: 1; }
  .krow-main .k-primary button { width: auto; min-width: 110px; }
  .krow-main .rmenu { grid-column: 3; grid-row: 1; }
  .krow-main .k-access { grid-column: 1 / -1; grid-row: 2; }
  .krow-main .k-use { grid-column: 1 / -1; grid-row: 3; }
  .mrow { grid-template-columns: minmax(0, 1fr) 38px; }
  .mrow .mono { grid-column: 1; grid-row: 2; }
  .mrow .rmenu { grid-column: 2; grid-row: 1 / span 2; }
}
@container (max-width: 699px) {
  .ubar { grid-template-columns: 1fr; gap: 6px; }
  .ubar .figs { text-align: left; }
  .urow.head { display: none; }
  .urow { grid-template-columns: 1fr auto; gap: 2px 12px; padding: 12px 18px; }
  .urow .c-day { grid-column: 1; font-weight: 600; }
  .urow .c-key { grid-column: 1; }
  .urow .c-model { grid-column: 1; color: var(--muted); }
  .urow .c-req, .urow .c-fail, .urow .c-in, .urow .c-out { display: none; }
  .urow .sub { display: block; grid-column: 1 / -1; color: var(--muted); font-size: 13px; }
}
@media (max-width: 640px) {
  .wrap { padding: 12px 14px 120px; }
  .top { padding-bottom: 12px; }
  .top h1 { font-size: 18px; }
  .who { font-size: 13px; flex-direction: column; align-items: flex-end; gap: 2px; }
  button { min-height: 44px; }
  button.quiet { min-height: 44px; }
  .kebab { width: 44px; }
  .tab { min-height: 48px; padding: 0 12px; }
  .bar-left { max-width: none; flex-basis: 100%; }
  .bar-left.counting { flex-basis: auto; }
  .bar .acts { margin-left: auto; }
  .bar-left:not(.counting) + .acts { margin-left: 0; width: 100%; }
  .bar-left:not(.counting) + .acts button { flex: 1; }
  .rq { padding: 16px; }
  .rq-acts button.primary { flex: 1 1 100%; }
  .rq-acts button { flex: 1; }
  .rq-more { grid-template-columns: 1fr; }
  .fields.cols { grid-template-columns: 1fr; }
  .formcard { padding: 16px; }
  .krow + .formcard { margin: 0 10px 12px; }
  .krow, .mrow { padding: 12px 14px; }
  .ms-id { display: none; }
  .ms-panel { max-height: 55vh; }
  .ms-row { min-height: 46px; }
  .loan button { min-height: 36px; }
  .toast { left: 16px; right: 16px; transform: none; bottom: 12px; max-width: none; }
  @media (prefers-reduced-motion: no-preference) { .toast { animation: none; } }
  .menu { min-width: 220px; }
  .menu button { min-height: 48px; }
}
`;

export const ACCOUNT_CSS = String.raw`
.wrap.narrow { max-width: 760px; }
textarea { width: 100%; min-height: 88px; padding: 10px 12px; border: 1px solid var(--control); border-radius: 8px; background: var(--panel); resize: vertical; line-height: 1.45; }
textarea::placeholder { color: var(--muted); opacity: 1; }
.section { padding: 18px; }
.section h2 { font-size: 17px; font-weight: 650; }
.section .sub { margin-top: 2px; }
.notice { border-left: 4px solid var(--danger); background: var(--danger-soft); border-radius: 0 10px 10px 0; padding: 12px 16px; font-weight: 500; margin-bottom: 12px; }
.askrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.askform { margin-top: 16px; max-width: 560px; display: grid; gap: 16px; }
.askform .two { display: grid; grid-template-columns: 1fr 180px; gap: 12px; }
.pilllist { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.pilllist .loan { font-size: 14px; }
.names { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 18px 16px; }
.names .chip { font-size: 13px; }
.myreq { padding: 12px 18px; border-top: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.myreq:first-child { border-top: 0; }
.myreq .meta { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.copybox { padding: 0 18px 16px; }
.copybox + .copybox { padding-top: 0; }
.copytop { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 0 6px; }
.code { display: block; width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; background: var(--chip); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; user-select: all; }
.dayrow { display: flex; justify-content: space-between; gap: 12px; padding: 10px 18px; border-top: 1px solid var(--line); font-size: 14px; }
.big { font-size: 22px; font-weight: 700; letter-spacing: -.01em; }
.fold.flush { border: 0; border-top: 1px solid var(--line); border-radius: 0 0 14px 14px; }
.fold.flush > summary { border-radius: 0 0 14px 14px; }
.intro { padding: 14px 18px 0; }
.chip.waiting { margin-left: 8px; }
.myreq .verdict.no { color: var(--muted); }
.section p.num { margin-top: 8px; }
.section .meter { max-width: 320px; }
@media (max-width: 640px) {
  .askform .two { grid-template-columns: 1fr; }
  .section { padding: 16px; }
  .names { padding: 12px 16px 16px; }
  .myreq, .dayrow { padding-left: 16px; padding-right: 16px; }
  .copybox { padding: 0 16px 16px; }
  .askform button.primary { width: 100%; }
}
`;
