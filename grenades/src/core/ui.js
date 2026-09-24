// HUD и панель настроек. Весь DOM создаётся здесь, HTML-страницы пустые.
const CSS = `
:root{--bg:#0e1013;--panel:rgba(17,19,23,.8);--brd:rgba(255,255,255,.13);--txt:#eef1f5;--dim:rgba(238,241,245,.6);--dim2:rgba(238,241,245,.38);
--acc:#e0503f;--acch:#ef6250;--mono:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--txt);font-family:var(--sans);-webkit-font-smoothing:antialiased}
canvas{display:block;touch-action:none}
.glass{background:var(--panel);border:1px solid var(--brd);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
#loader{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:var(--bg);text-align:center;padding:32px;transition:opacity .4s}
#loader.done{opacity:0;pointer-events:none}
#loader .bar{width:220px;height:3px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden}
#loader .bar i{display:block;height:100%;width:0;background:var(--acc);transition:width .2s}
#loader .t{font-size:15px;color:var(--dim)} #loader.err .t{color:var(--acc)}
#tag{position:fixed;z-index:20;top:16px;left:16px;padding:9px 13px;border-radius:10px}
#tag b{display:block;font-size:13px;font-weight:650;letter-spacing:.02em}
#tag i{display:block;margin-top:3px;font-style:normal;font-family:var(--mono);font-size:11px;color:var(--dim2)}
#hud{position:fixed;z-index:20;left:50%;bottom:22px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;width:min(460px,calc(100vw - 28px))}
#st{display:flex;align-items:center;gap:9px;padding:7px 13px;border-radius:999px;font-family:var(--mono);font-size:12px;color:var(--dim);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
#dot{width:7px;height:7px;border-radius:50%;background:#72bc8f;flex:none}
#dot.warn{background:#e8b45c}#dot.hot{background:var(--acc)}#dot.cold{background:#7d8189}
#go{font:inherit;font-size:14px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:#fff;background:var(--acc);border:1px solid rgba(255,255,255,.18);border-radius:11px;min-height:50px;padding:0 34px;cursor:pointer;box-shadow:0 10px 30px rgba(224,80,63,.25)}
#go:hover{background:var(--acch)}#go:focus-visible,.chip:focus-visible,.sw:focus-visible{outline:2px solid #fff;outline-offset:2px}
#go.soft{background:rgba(255,255,255,.08);box-shadow:none;border-color:var(--brd)}
#hint{position:fixed;z-index:20;left:16px;bottom:18px;max-width:min(46ch,36vw);font-family:var(--mono);font-size:11.5px;line-height:1.6;color:var(--dim2);pointer-events:none}
#tools{position:fixed;z-index:21;top:16px;right:16px;display:flex;gap:8px}
.ib{width:42px;height:42px;border-radius:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--txt);padding:0}
.ib svg{width:20px;height:20px}.ib.off{color:var(--dim2)}
#panel{position:fixed;z-index:21;top:66px;right:16px;width:280px;max-height:calc(100vh - 170px);overflow:auto;border-radius:12px;padding:10px 14px 14px}
#panel h4{margin:12px 0 6px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim2);font-weight:600}
.chips{display:grid;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:5px}
.chip{min-height:34px;border-radius:8px;border:1px solid var(--brd);background:rgba(255,255,255,.05);color:var(--dim);font:500 12.5px var(--sans);cursor:pointer}
.chip[aria-pressed=true]{background:rgba(224,80,63,.18);border-color:rgba(224,80,63,.6);color:#fff}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:34px;font-size:13px;color:var(--dim)}
.sw{appearance:none;-webkit-appearance:none;width:36px;height:21px;border-radius:999px;background:rgba(255,255,255,.16);position:relative;cursor:pointer;flex:none;margin:0}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;transition:transform .15s}
.sw:checked{background:var(--acc)}.sw:checked::after{transform:translateX(15px)}
#stats{font-family:var(--mono);font-size:11px;color:var(--dim2);margin-top:10px;line-height:1.5;white-space:pre}
#replay{position:fixed;z-index:22;left:50%;bottom:62px;transform:translateX(-50%);width:min(640px,calc(100vw - 28px));border-radius:12px;padding:10px 14px;display:flex;flex-direction:column;gap:6px}
#replay .top{display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:12px;color:var(--dim)}
#replay .top b{color:#fff;font-weight:600}
#replay input[type=range]{width:100%;accent-color:var(--acc)}
#replay .btns{display:flex;gap:6px}
#bench{position:fixed;z-index:70;left:16px;top:70px;border-radius:10px;padding:12px 14px;font-family:var(--mono);font-size:12px;white-space:pre;line-height:1.5;max-width:calc(100vw - 32px);overflow:auto}
@media (max-width:760px){#tag i,#hint{display:none}#panel{left:12px;right:12px;width:auto;top:64px;max-height:48vh}#hud{bottom:16px}#go{width:100%}}
`;

const ICON_SND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4z"/><path class="w" d="M15.6 9.2a4 4 0 0 1 0 5.6"/><path class="w" d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>';
const ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';

export class UI {
  constructor({ title, subtitle, hint, options }) {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; };
    this.loader = el(`<div id="loader"><div class="t">Загрузка three.js…</div><div class="bar"><i></i></div></div>`);
    this.tag = el(`<div id="tag" class="glass"><b>${title}</b><i>${subtitle}</i></div>`);
    this.hud = el(`<div id="hud"><div id="st" class="glass" role="status" aria-live="polite"><i id="dot"></i><span></span></div><button id="go"></button></div>`);
    this.hintEl = el(`<div id="hint">${hint}</div>`);
    this.tools = el(`<div id="tools"><button class="ib glass" id="bSnd" aria-label="Звук" title="Звук (M)">${ICON_SND}</button><button class="ib glass" id="bSet" aria-label="Настройки" aria-expanded="false" title="Настройки">${ICON_GEAR}</button></div>`);
    this.panel = el(`<div id="panel" class="glass" hidden></div>`);
    this.replayEl = el(`<div id="replay" class="glass" hidden>
      <div class="top"><b>ПОВТОР</b><span id="rT">t = 0</span><span id="rF" style="margin-left:auto"></span></div>
      <input type="range" id="rS" min="0" max="1000" value="0" aria-label="Таймлайн повтора">
      <div class="btns"><button class="chip" id="rP">Пауза</button><button class="chip" id="rR">С начала</button><button class="chip" id="rX">Выход</button></div></div>`);
    document.body.append(this.loader, this.tag, this.hud, this.hintEl, this.tools, this.panel, this.replayEl);
    this.statusText = this.hud.querySelector('#st span');
    this.dot = this.hud.querySelector('#dot');
    this.go = this.hud.querySelector('#go');
    this.handlers = {};
    this.values = {};
    this.buildPanel(options);
    this.tools.querySelector('#bSet').onclick = () => this.togglePanel();
    this.tools.querySelector('#bSnd').onclick = () => this.emit('mute');
    this.go.onclick = () => this.emit('action');
    this.replayEl.querySelector('#rP').onclick = () => this.emit('replayPause');
    this.replayEl.querySelector('#rR').onclick = () => this.emit('replayRestart');
    this.replayEl.querySelector('#rX').onclick = () => this.emit('replayExit');
    this.scrub = this.replayEl.querySelector('#rS');
    this.scrub.oninput = () => this.emit('replayScrub', this.scrub.value / 1000);
    this._last = {};
  }
  on(name, f) { this.handlers[name] = f; }
  emit(name, ...a) { if (this.handlers[name]) this.handlers[name](...a); }
  togglePanel(force) {
    const open = force ?? this.panel.hidden;
    this.panel.hidden = !open;
    this.tools.querySelector('#bSet').setAttribute('aria-expanded', String(open));
  }
  // options: [{type:'chips'|'switch', key, label, items?:[[value,label]], value}]
  buildPanel(options) {
    for (const o of options) {
      if (o.type === 'header') { const h = document.createElement('h4'); h.textContent = o.label; this.panel.appendChild(h); continue; }
      this.values[o.key] = o.value;
      if (o.type === 'chips') {
        const h = document.createElement('h4'); h.textContent = o.label; this.panel.appendChild(h);
        const g = document.createElement('div'); g.className = 'chips'; g.setAttribute('role', 'group'); g.setAttribute('aria-label', o.label);
        for (const [v, l] of o.items) {
          const b = document.createElement('button'); b.className = 'chip'; b.textContent = l; b.dataset.v = v;
          b.setAttribute('aria-pressed', String(v === o.value));
          b.onclick = () => this.set(o.key, v, true);
          g.appendChild(b);
        }
        g.dataset.key = o.key;
        this.panel.appendChild(g);
      } else {
        const r = document.createElement('label'); r.className = 'row';
        r.innerHTML = `<span>${o.label}</span><input type="checkbox" class="sw" data-key="${o.key}" ${o.value ? 'checked' : ''}>`;
        r.querySelector('input').onchange = (e) => this.set(o.key, e.target.checked, true);
        this.panel.appendChild(r);
      }
    }
    this.statsEl = document.createElement('div'); this.statsEl.id = 'stats'; this.panel.appendChild(this.statsEl);
  }
  set(key, v, fire) {
    this.values[key] = v;
    const g = this.panel.querySelector(`.chips[data-key="${key}"]`);
    if (g) for (const b of g.children) b.setAttribute('aria-pressed', String(b.dataset.v === String(v)));
    const s = this.panel.querySelector(`input[data-key="${key}"]`);
    if (s) s.checked = !!v;
    if (fire) this.emit('option', key, v);
  }
  progress(f, text) {
    this.loader.querySelector('i').style.width = `${Math.round(f * 100)}%`;
    if (text) this.loader.querySelector('.t').textContent = text;
  }
  ready() { this.loader.classList.add('done'); setTimeout(() => this.loader.remove(), 500); }
  fail(msg) { this.loader.classList.add('err'); this.loader.querySelector('.t').textContent = msg; }
  // Обновления DOM только при изменении значения
  status(text, cls) {
    if (this._last.st !== text) { this.statusText.textContent = text; this._last.st = text; }
    if (this._last.cls !== cls) { this.dot.className = cls || ''; this._last.cls = cls; }
  }
  action(label, soft) {
    if (this._last.go !== label) { this.go.textContent = label; this._last.go = label; this.go.hidden = !label; }
    if (this._last.soft !== soft) { this.go.classList.toggle('soft', !!soft); this._last.soft = soft; }
  }
  hint(text) { if (this._last.hint !== text) { this.hintEl.innerHTML = text; this._last.hint = text; } }
  muted(m) { this.tools.querySelector('#bSnd').classList.toggle('off', m); this.tools.querySelector('#bSnd').querySelectorAll('.w').forEach((p) => { p.style.opacity = m ? 0 : 1; }); }
  stats(text) { if (!this.panel.hidden && this._last.stats !== text) { this.statsEl.textContent = text; this._last.stats = text; } }
  showReplay(on) { this.replayEl.hidden = !on; }
  replayInfo(tText, fpsText, pos, playing) {
    if (this._last.rt !== tText) { this.replayEl.querySelector('#rT').textContent = tText; this._last.rt = tText; }
    if (this._last.rf !== fpsText) { this.replayEl.querySelector('#rF').textContent = fpsText; this._last.rf = fpsText; }
    if (document.activeElement !== this.scrub) this.scrub.value = Math.round(pos * 1000);
    const pl = playing ? 'Пауза' : 'Играть';
    if (this._last.rp !== pl) { this.replayEl.querySelector('#rP').textContent = pl; this._last.rp = pl; }
  }
  benchReport(text) {
    let b = document.getElementById('bench');
    if (!b) { b = document.createElement('div'); b.id = 'bench'; b.className = 'glass'; document.body.appendChild(b); }
    b.textContent = text;
  }
}
