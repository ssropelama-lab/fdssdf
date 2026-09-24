// Звуковой движок гранат. Никаких осцилляторов и модального синтеза: все удары — шумовой
// импульс через сильно задемпфированные фильтры (Q ≤ 3), всё тяжёлое печётся заранее.

const TWO_PI = Math.PI * 2;
const C_SOUND = 343;
const BLAST_VARIANTS = 4;
const IMPACT_VARIANTS = 4;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rr = (rng, a, b) => a + (b - a) * rng();

// ---------- DSP для запечки (не горячий путь) ----------

// RBJ-биквад, коэффициенты нормированы на a0. 'bp' — с усилением 0 дБ в центре.
function coefs(type, f, Q, sr, out) {
  f = Math.min(Math.max(f, 10), sr * 0.45);
  const w = TWO_PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * Q);
  const a0 = 1 + al;
  let b0, b1, b2;
  if (type === 'lp') { b1 = 1 - cs; b0 = b2 = b1 / 2; }
  else if (type === 'hp') { b1 = -(1 + cs); b0 = b2 = (1 + cs) / 2; }
  else { b0 = al; b1 = 0; b2 = -al; }
  out[0] = b0 / a0; out[1] = b1 / a0; out[2] = b2 / a0; out[3] = -2 * cs / a0; out[4] = (1 - al) / a0;
  return out;
}
const C5 = new Float64Array(5);

function filterAdd(src, dst, off, c, g) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const n = Math.min(src.length, dst.length - off);
  for (let i = 0; i < n; i++) {
    const x = src[i];
    const y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    dst[off + i] += g * y;
  }
}

function onePoleLP(a, fc, sr) {
  const k = Math.exp(-TWO_PI * fc / sr);
  let y = 0;
  for (let i = 0; i < a.length; i++) { y = (1 - k) * a[i] + k * y; a[i] = y; }
}

function dcBlock(a, fc, sr) {
  const R = Math.exp(-TWO_PI * fc / sr);
  let x1 = 0, y1 = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]; const y = x - x1 + R * y1; x1 = x; y1 = y; a[i] = y; }
}

function peakOf(a) { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } return p; }
function scale(a, k) { for (let i = 0; i < a.length; i++) a[i] *= k; }
function normalize(a, target) { const p = peakOf(a); if (p > 0) scale(a, target / p); }
function addInto(d, s) { for (let i = 0; i < d.length; i++) d[i] += s[i]; }
function saturate(d, drive) { const k = 1 / Math.tanh(drive); for (let i = 0; i < d.length; i++) d[i] = Math.tanh(drive * d[i]) * k; }
function echo(d, gd, g) { for (let i = d.length - 1; i >= gd; i--) d[i] += g * d[i - gd]; }
function addTap(d, L, R, off, gl, gr) {
  for (let i = 0, n = d.length - off; i < n; i++) { const v = d[i]; L[off + i] += gl * v; R[off + i] += gr * v; }
}

// Шумовой удар: линейная атака + экспонента, затем полосы [тип, f, Q, усиление].
function hit(out, sr, rng, atSec, tau, amp, bands, att = 0.0003) {
  const at = Math.max(0, Math.round(atSec * sr));
  if (at >= out.length) return;
  const n = Math.min(out.length - at, Math.ceil((att + tau * 9) * sr));
  const ex = new Float32Array(n);
  const na = Math.max(1, att * sr), k = Math.exp(-1 / (tau * sr));
  let e = 1;
  for (let i = 0; i < n; i++) {
    const env = i < na ? i / na : (e *= k);
    ex[i] = (rng() * 2 - 1) * env;
  }
  for (const b of bands) filterAdd(ex, out, at, coefs(b[0], b[1], b[2], sr, C5), b[3] * amp);
}

// ---------- Банк ударов металла ----------

const IMPACTS = {
  clip(o, sr, r) {
    const f = rr(r, 0.9, 1.1);
    const B = [['hp', 2500, 0.7, 0.8], ['bp', 4200 * f, 2.2, 1.2], ['bp', 7600 * f, 2.5, 0.7]];
    hit(o, sr, r, 0, 0.0012, 1, B, 0.0001);
    hit(o, sr, r, rr(r, 0.006, 0.014), 0.001, rr(r, 0.35, 0.55), B, 0.0001);
    hit(o, sr, r, rr(r, 0.022, 0.03), 0.0009, rr(r, 0.1, 0.18), B, 0.0001);
  },
  spring(o, sr, r) {
    // сухой «клац» + дребезг пружины неравномерными щелчками (без тона)
    hit(o, sr, r, 0, 0.0025, 1, [['bp', rr(r, 1600, 2000), 1.2, 1], ['bp', rr(r, 3100, 3700), 2, 0.8], ['lp', 700, 0.7, 0.5]], 0.0001);
    let t = 0.006, a = 0.4;
    const cnt = 5 + (r() * 4 | 0);
    for (let i = 0; i < cnt && t < 0.05; i++) {
      hit(o, sr, r, t, rr(r, 0.0008, 0.0014), a, [['bp', rr(r, 3000, 6500), 2.5, 1], ['hp', 5000, 0.7, 0.4]], 0.0001);
      t += rr(r, 0.004, 0.011); a *= rr(r, 0.6, 0.85);
    }
  },
  leverHit(o, sr, r) {
    hit(o, sr, r, 0, 0.003, 1, [['lp', rr(r, 400, 600), 0.7, 0.7], ['bp', rr(r, 2300, 2900), 1.5, 1], ['bp', rr(r, 4800, 5600), 2, 0.6]], 0.0002);
    hit(o, sr, r, rr(r, 0.003, 0.008), 0.0012, 0.3, [['bp', rr(r, 3500, 6000), 2, 1]], 0.0001);
  },
  pinHit(o, sr, r) {
    const B = [['bp', rr(r, 5000, 6200), 2, 1], ['hp', 7000, 0.7, 0.5], ['bp', 2200, 1.5, 0.3]];
    hit(o, sr, r, 0, 0.0015, 1, B, 0.0001);
    hit(o, sr, r, rr(r, 0.018, 0.03), 0.001, rr(r, 0.15, 0.3), B, 0.0001);
  },
  clipHit(o, sr, r) {
    hit(o, sr, r, 0, 0.002, 1, [['bp', rr(r, 2900, 3500), 1.8, 1], ['bp', rr(r, 5500, 6500), 2.5, 0.6], ['lp', 900, 0.7, 0.3]], 0.0001);
  },
  ring(o, sr, r) {
    // звяк кольца — несколько щелчков по разным полосам, никакой устойчивой частоты
    let t = 0, a = 1;
    const cnt = 2 + (r() * 3 | 0);
    for (let i = 0; i < cnt; i++) {
      hit(o, sr, r, t, rr(r, 0.001, 0.002), a, [['bp', rr(r, 4500, 8000), rr(r, 2.2, 3), 1], ['hp', 6000, 0.7, 0.4]], 0.0001);
      t += rr(r, 0.003, 0.009); a *= rr(r, 0.45, 0.75);
    }
  },
  bodyHit(o, sr, r) {
    hit(o, sr, r, 0, 0.007, 1, [['lp', rr(r, 220, 300), 0.7, 1.4], ['bp', rr(r, 800, 1000), 1, 0.5], ['bp', rr(r, 2100, 2500), 1.5, 0.35]], 0.0005);
    hit(o, sr, r, 0, 0.0008, 0.5, [['bp', rr(r, 3000, 4000), 1.5, 1]], 0.0001);
  },
  primer(o, sr, r) {
    // «щёлк» капсюля + «пух» газов (~80 мс)
    hit(o, sr, r, 0, 0.0006, 1, [['hp', 3000, 0.7, 1], ['bp', 6000, 1.5, 0.6]], 0.00005);
    hit(o, sr, r, 0.002, 0.018, 0.5, [['lp', rr(r, 1000, 1400), 0.7, 0.8], ['bp', 400, 1, 0.4]], 0.004);
  },
};
const IMPACT_LEN = { clip: 0.07, spring: 0.09, leverHit: 0.07, pinHit: 0.07, clipHit: 0.06, ring: 0.07, bodyHit: 0.1, primer: 0.14 };
const IMPACT_GAIN = { clip: 0.5, spring: 0.7, leverHit: 0.45, pinHit: 0.3, clipHit: 0.35, ring: 0.3, bodyHit: 0.8, primer: 0.6 };

// ---------- Хлопки ----------

// Фридлендер: p(t) = Ps(1 − t/t*)·e^(−b·t/t*), при b < 1 заметная отрицательная фаза.
function friedlander(out, at, sr, Ps, ts, b, len) {
  const n = Math.min(out.length - at, Math.ceil(len * sr));
  const k = 1 / (sr * ts);
  for (let i = 0; i < n; i++) { const x = i * k; out[at + i] += Ps * (1 - x) * Math.exp(-b * x); }
}

// Свист осколка: шум через bp с низкой добротностью, центр уходит вниз (допплер).
function whizz(out, at, sr, rng, dur, f0, f1, amp) {
  const n = Math.min(out.length - at, Math.ceil(dur * sr));
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    if ((i & 31) === 0) coefs('bp', f0 * Math.pow(f1 / f0, u), 2.5, sr, C5);
    const w = 4 * u * (1 - u), env = w * Math.sqrt(w);
    const x = (rng() * 2 - 1) * env;
    const y = C5[0] * x + C5[1] * x1 + C5[2] * x2 - C5[3] * y1 - C5[4] * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[at + i] += amp * y;
  }
}

// Сверхзвуковой щелчок осколка — N-волна.
function nwave(out, at, m, amp) {
  m = Math.max(3, m | 0);
  for (let i = 0; i < m && at + i < out.length; i++) out[at + i] += amp * (1 - 2 * i / (m - 1));
}

// Ранние отражения: мнимые источники в комнате 14×10×4 м (пол уже учтён в сухом сигнале).
function* earlyReflections(d, sr, rng) {
  const W = 14, H = 4, D = 10;
  const sx = rr(rng, 3, 11), sy = 0.05, sz = rr(rng, 2.5, 7.5);
  const ang = rng() * TWO_PI, dist = rr(rng, 3, 7);
  const lx = Math.min(W - 0.5, Math.max(0.5, sx + Math.cos(ang) * dist)), ly = 1.6;
  const lz = Math.min(D - 0.5, Math.max(0.5, sz + Math.sin(ang) * dist));
  const dd = Math.hypot(sx - lx, sy - ly, sz - lz);
  const imgs = [
    [-sx, sy, sz, 1], [2 * W - sx, sy, sz, 1], [sx, sy, -sz, 1], [sx, sy, 2 * D - sz, 1], [sx, 2 * H - sy, sz, 1],
    [-sx, sy, -sz, 2], [2 * W - sx, sy, -sz, 2], [-sx, sy, 2 * D - sz, 2], [2 * W - sx, sy, 2 * D - sz, 2],
    [-sx, 2 * H - sy, sz, 2], [2 * W - sx, 2 * H - sy, sz, 2], [sx, 2 * H - sy, -sz, 2],
  ];
  const L = new Float32Array(d.length), R = new Float32Array(d.length);
  for (const im of imgs) {
    const di = Math.hypot(im[0] - lx, im[1] - ly, im[2] - lz);
    const off = Math.round((di - dd) / C_SOUND * sr);
    const g = (dd / di) * Math.pow(0.72, im[3]);
    const p = rng() * 2 - 1, gl = g * Math.sqrt((1 - p) / 2), gr = g * Math.sqrt((1 + p) / 2);
    addTap(d, L, R, off, gl, gr);
    yield;
  }
  onePoleLP(L, 5000, sr); onePoleLP(R, 5000, sr);
  return [L, R];
}

// Генератор: yield между стадиями, чтобы prerender раскладывал работу по idle-слотам.
// Циклы по сэмплам — только в обычных функциях: внутри генератора V8 их плохо оптимизирует.
function* synthBlastGen(kind, seed, sr) {
  const rng = mulberry32(seed);
  const m67 = kind === 'm67';
  const n = Math.ceil((m67 ? 2.2 : 0.7) * sr);
  const d = new Float32Array(n);
  const at = 64, t0 = at / sr;
  const ts = m67 ? rr(rng, 0.0024, 0.0032) : rr(rng, 0.0009, 0.0013);
  friedlander(d, at, sr, 1, ts, rr(rng, 0.75, 1.0), ts * 40);
  // «тело» — медленная волна расширения газов, глухой удар
  const th = new Float32Array(n);
  friedlander(th, at, sr, m67 ? 0.7 : 0.3, m67 ? rr(rng, 0.013, 0.02) : rr(rng, 0.005, 0.007), 0.9, 0.4);
  onePoleLP(th, m67 ? 260 : 500, sr);
  addInto(d, th);
  hit(d, sr, rng, t0, m67 ? 0.004 : 0.0025, m67 ? 0.35 : 0.5, [['hp', m67 ? 1500 : 2500, 0.7, 1]], 0.0001);
  normalize(d, 1);
  yield;
  saturate(d, m67 ? 2.2 : 3.0);
  // отражение от пола
  echo(d, Math.round(rr(rng, 0.0004, 0.0015) * sr), 0.6);

  if (m67) {
    yield;
    const nz = 6 + (rng() * 9 | 0);
    for (let i = 0; i < nz; i++) {
      const t = t0 + 0.004 + Math.pow(rng(), 1.5) * 0.15, f0 = rr(rng, 4500, 8000);
      whizz(d, Math.round(t * sr), sr, rng, rr(rng, 0.012, 0.045), f0, f0 * rr(rng, 0.3, 0.5), rr(rng, 0.05, 0.16));
    }
    const ns = 15 + (rng() * 20 | 0);
    for (let i = 0; i < ns; i++) {
      const t = 0.002 + rng() * rng() * 0.12;
      nwave(d, Math.round((t0 + t) * sr), rr(rng, 0.00015, 0.0004) * sr, rr(rng, 0.05, 0.22) * (1 - t / 0.15));
    }
    // попадания осколков в стены и пол
    const nh = 8 + (rng() * 9 | 0);
    for (let i = 0; i < nh; i++) {
      hit(d, sr, rng, t0 + rr(rng, 0.02, 0.15), rr(rng, 0.0008, 0.002), rr(rng, 0.03, 0.1), [['bp', rr(rng, 1500, 5000), rr(rng, 1, 2.5), 1]], 0.0001);
    }
    // стук падающего мусора
    yield;
    let t = 0.22;
    for (;;) {
      const rate = 90 * Math.exp(-(t - 0.22) / 0.45) + 5;
      t += -Math.log(1 - rng()) / rate;
      if (t > 2.05) break;
      const big = rng() < 0.18;
      const a = rr(rng, 0.006, 0.035) * (big ? 2 : 1) * Math.max(0.25, Math.exp(-(t - 0.22) / 0.9));
      if (big) hit(d, sr, rng, t, rr(rng, 0.002, 0.004), a, [['lp', rr(rng, 400, 900), 0.7, 1], ['bp', rr(rng, 1200, 2500), 1.2, 0.5]]);
      else hit(d, sr, rng, t, rr(rng, 0.0005, 0.0015), a, [['bp', rr(rng, 2000, 7000), rr(rng, 1, 2.5), 1]], 0.0001);
    }
  } else {
    // догорающие частицы состава — мелкое потрескивание
    let t = 0.015;
    for (;;) {
      t += -Math.log(1 - rng()) / (250 * Math.exp(-t / 0.12) + 10);
      if (t > 0.55) break;
      hit(d, sr, rng, t0 + t, rr(rng, 0.0003, 0.001), rr(rng, 0.004, 0.025) * Math.exp(-t / 0.25), [['hp', 3000, 0.7, 1]], 0.0001);
    }
  }
  dcBlock(d, 18, sr);
  normalize(d, 0.95);
  yield;
  const [eL, eR] = yield* earlyReflections(d, sr, rng);
  return { dry: d, eL, eR };
}

function synthBlast(kind, seed, sr) {
  const g = synthBlastGen(kind, seed, sr);
  let r;
  while (!(r = g.next()).done);
  return r.value;
}

// Шумовой импульсный отклик комнаты, верха затухают быстрее.
function synthIR(sr, seed, T60 = 1.6, len = 2.0) {
  const n = Math.ceil(len * sr), pre = Math.round(0.012 * sr), fade = 0.008 * sr;
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const rng = mulberry32(seed + ch * 7919), a = out[ch];
    let y = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const k = Math.exp(-TWO_PI * 9000 * Math.exp(-t * 1.2) / sr);
      y = (1 - k) * (rng() * 2 - 1) + k * y;
      a[i] = y * Math.exp(-6.9 * t / T60) * Math.min(1, (i - pre) / fade);
    }
  }
  return out;
}

function synthFuse(sr, rng) {
  const N = Math.ceil(3 * sr), F = Math.ceil(0.08 * sr), tot = N + F;
  const x = new Float32Array(tot), hiss = new Float32Array(tot);
  // «дыхание» горения — кусочно-линейная огибающая
  let i = 0, a0 = rr(rng, 0.5, 1);
  while (i < tot) {
    const seg = Math.round(rr(rng, 0.03, 0.08) * sr), a1 = rr(rng, 0.5, 1);
    for (let j = 0; j < seg && i < tot; j++, i++) hiss[i] = (rng() * 2 - 1) * (a0 + (a1 - a0) * j / seg);
    a0 = a1;
  }
  filterAdd(hiss, x, 0, coefs('hp', 1500, 0.7, sr, C5), 0.5);
  filterAdd(hiss, x, 0, coefs('bp', 4500, 0.8, sr, C5), 0.6);
  let t = 0;
  for (;;) {
    t += -Math.log(1 - rng()) / 30;
    if (t > tot / sr - 0.01) break;
    if (rng() < 0.1) hit(x, sr, rng, t, rr(rng, 0.001, 0.002), rr(rng, 1, 2), [['lp', 1500, 0.7, 0.8], ['bp', 3000, 1.2, 0.6]], 0.0001);
    else hit(x, sr, rng, t, rr(rng, 0.0002, 0.0008), rr(rng, 0.3, 1.2), [['hp', 2000, 0.7, 1], ['bp', rr(rng, 3000, 8000), 1.5, 0.6]], 0.00005);
  }
  // бесшовная петля: хвост перетекает в начало
  const out = x.subarray(0, N);
  for (let j = 0; j < F; j++) { const u = j / F; out[j] = x[j] * u + x[N + j] * (1 - u); }
  normalize(out, 0.9);
  return out;
}

// ---------- Stick–slip в AudioWorklet ----------

const WORKLET_SRC = `
function bp(f,Q){const w=2*Math.PI*f/sampleRate,cs=Math.cos(w),al=Math.sin(w)/(2*Q),a0=1+al;return[al/a0,0,-al/a0,-2*cs/a0,(1-al)/a0];}
class StickSlip extends AudioWorkletProcessor{
 static get parameterDescriptors(){return[
  {name:'velocity',defaultValue:0,minValue:-20,maxValue:20,automationRate:'k-rate'},
  {name:'normal',defaultValue:0,minValue:0,maxValue:20,automationRate:'k-rate'},
  {name:'active',defaultValue:0,minValue:0,maxValue:1,automationRate:'k-rate'}];}
 constructor(){super();
  this.xd=0;this.xc=0;this.mu=0.4;this.env=0;this.s=0x2545F491;
  this.c=[bp(1100,1.4),bp(3100,2.2),bp(6300,2.6)];this.g=[0.5,1,0.6];this.z=new Float64Array(12);
  this.kEnv=Math.exp(-1/(0.0012*sampleRate));}
 r(){let x=this.s;x^=x<<13;x^=x>>>17;x^=x<<5;this.s=x;return(x>>>0)/4294967296;}
 process(_,outs,p){
  const out=outs[0],o=out&&out[0];if(!o)return true;
  const on=p.active[0]>0.5;
  if(!on&&this.env<1e-6){for(let c=0;c<out.length;c++)out[c].fill(0);return true;}
  const v=p.velocity[0],N=p.normal[0],dx=v*1000/sampleRate,MUS=0.4,MUK=0.24,av=Math.min(1,Math.abs(v)*4);
  const c=this.c,g=this.g,z=this.z,k=this.kEnv;
  for(let i=0;i<o.length;i++){
   if(on&&N>0){this.xd+=dx;const F=this.xd-this.xc,aF=Math.abs(F);
    if(aF>this.mu*N){const drop=aF-MUK*N;
     this.xc+=Math.sign(F)*2*drop*(0.8+0.4*this.r());
     this.env=Math.min(1.5,this.env+drop*(0.6+4*av));
     this.mu=MUS*(0.5+this.r());}}
   const x=(this.r()*2-1)*this.env+(this.r()*2-1)*0.004*av*N;this.env*=k;
   let y=0;
   for(let b=0;b<3;b++){const q=c[b],j=b*4;
    const yb=q[0]*x+q[2]*z[j+1]-q[3]*z[j+2]-q[4]*z[j+3];
    z[j+1]=z[j];z[j]=x;z[j+3]=z[j+2];z[j+2]=yb;y+=g[b]*yb;}
   o[i]=y;}
  this.xd-=this.xc;this.xc=0;
  for(let ch=1;ch<out.length;ch++)out[ch].set(o);
  return true;}
}
registerProcessor('grenade-stick-slip',StickSlip);
`;

// ---------- Вспомогательное ----------

function setPos(p, v) {
  if (p.positionX) { p.positionX.value = v.x; p.positionY.value = v.y; p.positionZ.value = v.z; }
  else p.setPosition(v.x, v.y, v.z);
}

// Резолвится с IdleDeadline (или null без requestIdleCallback).
const idle = () => new Promise((res) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(res, { timeout: 150 });
  else setTimeout(() => res(null), 16);
});
const hasTime = (dl) => !!dl && !dl.didTimeout && dl.timeRemaining() > 6;

function renderOffline(oc) {
  return new Promise((res, rej) => {
    oc.oncomplete = (e) => res(e.renderedBuffer);
    try { const p = oc.startRendering(); if (p && p.then) p.then(res, rej); } catch (e) { rej(e); }
  });
}

// ---------- Движок ----------

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this._unlocking = null;
    this._pre = null;
    this._wantPre = false;
    this._bank = new Map();
    this._variants = { m67: [], m84: [] };
    this._fallback = { m67: null, m84: null };
    this._last = { m67: null, m84: null };
    this._active = new Set();
    this._live = 0;
    this._persist = 0;
    this._rr = 0;
    this._tinnitusOn = false;
    this._tinn = null;
    this._muted = false;
    this._lp = { x: 0, y: 0, z: 0 };
    this._curve = new Float32Array(128);
    this._wander = new Float32Array(48);
    this._stats = { nodes: 0, variants: 0 };
    this._sc = null; this._wh = null; this._fu = null;

    this.scrape = {
      start: () => this._scrapeStart(),
      set: (v, n, pos) => this._scrapeSet(v, n, pos),
      stop: () => this._scrapeStop(),
    };
    this.whoosh = {
      start: () => this._whooshStart(),
      set: (speed, pos) => this._whooshSet(speed, pos),
      stop: () => this._whooshStop(),
    };
    this.fuse = {
      start: (pos, duration) => this._fuseStart(pos, duration),
      setPos: (pos) => { if (this._fu && pos) setPos(this._fu.pan, pos); },
      stop: () => this._fuseStop(),
    };
  }

  unlock() {
    if (this._unlocking) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this._unlocking;
    }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return (this._unlocking = Promise.resolve(false));
    // контекст создаётся синхронно — внутри жеста пользователя
    let ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
    this.ctx = ctx;
    this._buildGraph();
    this._unlocking = (async () => {
      try { if (ctx.state !== 'running') await ctx.resume(); } catch (e) { /* разблокируется позже */ }
      // iOS: тихий буфер окончательно «будит» вывод
      try { const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); s.connect(ctx.destination); s.start(); } catch (e) { /* нет */ }
      await this._loadWorklet();
      if (this._wantPre) this.prerender();
      return true;
    })();
    return this._unlocking;
  }

  _buildGraph() {
    const c = this.ctx;
    this._sfx = c.createGain();
    this._muffle = c.createBiquadFilter();
    this._muffle.type = 'lowpass'; this._muffle.frequency.value = 18000; this._muffle.Q.value = -3.01;
    this._duck = c.createGain();
    this._comp = c.createDynamicsCompressor();
    this._comp.threshold.value = -6; this._comp.knee.value = 6; this._comp.ratio.value = 12;
    this._comp.attack.value = 0.002; this._comp.release.value = 0.25;
    this._master = c.createGain();
    this._master.gain.value = this._muted ? 0 : 1;
    this._sfx.connect(this._muffle); this._muffle.connect(this._duck); this._duck.connect(this._comp);
    this._comp.connect(this._master); this._master.connect(c.destination);
    this._persist = 5;
    const L = c.listener, p = this._lp;
    if (L.positionX) { L.positionX.value = p.x; L.positionY.value = p.y; L.positionZ.value = p.z; }
    else if (L.setPosition) L.setPosition(p.x, p.y, p.z);
  }

  async _loadWorklet() {
    const c = this.ctx;
    let ok = false;
    if (c.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      const urls = [];
      try { urls.push(URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }))); } catch (e) { /* нет Blob */ }
      urls.push('data:text/javascript;charset=utf-8,' + encodeURIComponent(WORKLET_SRC));
      for (const u of urls) {
        try { await c.audioWorklet.addModule(u); ok = true; break; } catch (e) { /* пробуем следующий */ }
      }
      if (urls[0].startsWith('blob:')) URL.revokeObjectURL(urls[0]);
    }
    const g = c.createGain(); g.gain.value = 0;
    const pan = this._panner(null, 1);
    let node = null, vP = null, nP = null, aP = null, bp = null, src = null;
    if (ok) {
      try {
        node = new AudioWorkletNode(c, 'grenade-stick-slip', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
        vP = node.parameters.get('velocity'); nP = node.parameters.get('normal'); aP = node.parameters.get('active');
        node.connect(g);
      } catch (e) { node = null; }
    }
    if (!node) {
      // запасной вариант без worklet: шум через полосовой, громкость от скорости
      src = c.createBufferSource(); src.buffer = this._noise(); src.loop = true;
      bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2800; bp.Q.value = 1;
      src.connect(bp); bp.connect(g); src.start();
    }
    g.connect(pan); pan.connect(this._sfx);
    this._sc = { node, vP, nP, aP, g, pan, bp, src, on: false };
    this._persist += node ? 3 : 4;
  }

  _panner(pos, rolloff) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower'; p.distanceModel = 'inverse';
    p.refDistance = 0.5; p.maxDistance = 200; p.rolloffFactor = rolloff;
    setPos(p, pos || this._lp);
    return p;
  }

  _noise() {
    if (this._noiseBuf) return this._noiseBuf;
    const c = this.ctx, n = 2 * c.sampleRate, b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    const r = mulberry32(12345);
    for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
    return (this._noiseBuf = b);
  }

  _fuseBuf() {
    if (this._fuseB) return this._fuseB;
    const c = this.ctx, d = synthFuse(c.sampleRate, mulberry32(777));
    const b = c.createBuffer(1, d.length, c.sampleRate); b.copyToChannel(d, 0);
    return (this._fuseB = b);
  }

  _irBuf() {
    if (this._ir) return this._ir;
    const c = this.ctx, [L, R] = synthIR(c.sampleRate, 4242);
    const b = c.createBuffer(2, L.length, c.sampleRate); b.copyToChannel(L, 0); b.copyToChannel(R, 1);
    this._irData = [L, R];
    return (this._ir = b);
  }

  _bakeImpact(name) {
    const c = this.ctx, sr = c.sampleRate, fn = IMPACTS[name];
    const list = [];
    for (let v = 0; v < IMPACT_VARIANTS; v++) {
      const d = new Float32Array(Math.ceil(IMPACT_LEN[name] * sr));
      fn(d, sr, mulberry32(0x9E37 * (v + 1) + name.length * 131 + name.charCodeAt(0)));
      normalize(d, 0.8);
      const b = c.createBuffer(1, d.length, sr); b.copyToChannel(d, 0);
      list.push(b);
    }
    this._bank.set(name, list);
    return list;
  }

  prerender() {
    if (!this.ctx) { this._wantPre = true; return Promise.resolve(); }
    if (this._pre) return this._pre;
    const blastJob = (kind, v) => async () => {
      const b = await this._renderBlast(kind, (kind === 'm67' ? 6700 : 8400) + v * 977, true);
      if (b) this._variants[kind].push(b);
    };
    // первыми — по одному варианту хлопка, чтобы ранний взрыв не ушёл в синхронный запасной путь
    const jobs = [() => { this._noise(); this._irBuf(); }, blastJob('m84', 0), blastJob('m67', 0), () => this._fuseBuf()];
    for (const n of Object.keys(IMPACTS)) jobs.push(() => { if (!this._bank.has(n)) this._bakeImpact(n); });
    for (let v = 1; v < BLAST_VARIANTS; v++) jobs.push(blastJob('m84', v), blastJob('m67', v));
    this._pre = (async () => {
      let dl = null;
      for (const j of jobs) {
        if (!hasTime(dl)) dl = await idle();
        try { await j(); } catch (e) { console.warn('audio prerender:', e); }
        dl = null;
      }
    })();
    return this._pre;
  }

  // Возвращает 3-канальный буфер: 0 — прямой звук, 1/2 — комната (отражения + хвост).
  async _renderBlast(kind, seed, chunked = false) {
    const c = this.ctx, sr = c.sampleRate;
    let res;
    if (chunked) {
      const g = synthBlastGen(kind, seed, sr);
      let r, dl = await idle();
      while (!(r = g.next()).done) if (!hasTime(dl)) dl = await idle();
      res = r.value;
    } else res = synthBlast(kind, seed, sr);
    const { dry, eL, eR } = res;
    const len = dry.length + Math.ceil((kind === 'm67' ? 1.9 : 1.6) * sr);
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    let out;
    try {
      const oc = new OAC(3, len, sr);
      const b = oc.createBuffer(1, dry.length, sr); b.copyToChannel(dry, 0);
      const e = oc.createBuffer(2, eL.length, sr); e.copyToChannel(eL, 0); e.copyToChannel(eR, 1);
      const s = oc.createBufferSource(); s.buffer = b;
      const es = oc.createBufferSource(); es.buffer = e;
      const conv = oc.createConvolver(); conv.normalize = false; conv.buffer = this._irBuf();
      const sp = oc.createChannelSplitter(2), sp2 = oc.createChannelSplitter(2), m = oc.createChannelMerger(3);
      s.connect(m, 0, 0); s.connect(conv); conv.connect(sp); es.connect(sp2);
      sp.connect(m, 0, 1); sp.connect(m, 1, 2); sp2.connect(m, 0, 1); sp2.connect(m, 1, 2);
      m.connect(oc.destination);
      s.start(0); es.start(0);
      out = await renderOffline(oc);
    } catch (err) {
      return this._jsBlast(dry, eL, eR, len);
    }
    const w1 = out.getChannelData(1), w2 = out.getChannelData(2);
    const p = Math.max(peakOf(w1), peakOf(w2));
    if (p > 0) { scale(w1, 0.4 / p); scale(w2, 0.4 / p); }
    return out;
  }

  // Синхронный запасной вариант: хвост ≈ IR × энергия импульса (источник импульсный).
  _jsBlast(dry, eL, eR, len) {
    const c = this.ctx, sr = c.sampleRate;
    this._irBuf();
    const [IL, IR] = this._irData;
    const b = c.createBuffer(3, len, sr);
    const d0 = b.getChannelData(0), w1 = b.getChannelData(1), w2 = b.getChannelData(2);
    d0.set(dry.subarray(0, Math.min(dry.length, len)));
    w1.set(eL.subarray(0, Math.min(eL.length, len))); w2.set(eR.subarray(0, Math.min(eR.length, len)));
    let e = 0;
    for (let i = 0, n = Math.min(dry.length, Math.round(0.03 * sr)); i < n; i++) e += Math.abs(dry[i]);
    const off = 64, k = e * 0.02;
    for (let i = 0, n = Math.min(IL.length, len - off); i < n; i++) { w1[off + i] += IL[i] * k; w2[off + i] += IR[i] * k; }
    const p = Math.max(peakOf(w1), peakOf(w2));
    if (p > 0) { scale(w1, 0.4 / p); scale(w2, 0.4 / p); }
    return b;
  }

  _blastBuffer(kind, seed) {
    const list = this._variants[kind];
    if (list.length) return list[(seed >>> 0) % list.length];
    if (!this._fallback[kind]) {
      const sr = this.ctx.sampleRate, { dry, eL, eR } = synthBlast(kind, seed >>> 0, sr);
      this._fallback[kind] = this._jsBlast(dry, eL, eR, dry.length + Math.ceil(1.6 * sr));
    }
    this.prerender();
    return this._fallback[kind];
  }

  setListener(camera) {
    const e = camera.matrixWorld.elements, p = this._lp;
    p.x = e[12]; p.y = e[13]; p.z = e[14];
    if (!this.ctx) return;
    let fx = -e[8], fy = -e[9], fz = -e[10], ux = e[4], uy = e[5], uz = e[6];
    const fl = Math.hypot(fx, fy, fz) || 1, ul = Math.hypot(ux, uy, uz) || 1;
    fx /= fl; fy /= fl; fz /= fl; ux /= ul; uy /= ul; uz /= ul;
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.value = p.x; L.positionY.value = p.y; L.positionZ.value = p.z;
      L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
      L.upX.value = ux; L.upY.value = uy; L.upZ.value = uz;
    } else {
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  _track(src, nodes) {
    this._live += nodes.length;
    src.onended = () => {
      for (const n of nodes) { try { n.disconnect(); } catch (e) { /* уже */ } }
      this._live -= nodes.length;
    };
  }

  play(name, o) {
    const c = this.ctx;
    if (!c || !IMPACTS[name]) return null;
    const list = this._bank.get(name) || this._bakeImpact(name);
    let idx;
    if (o && o.seed != null) idx = (o.seed >>> 0) % list.length;
    else idx = this._rr = (this._rr + 1 + ((Math.random() * (list.length - 1)) | 0)) % list.length;
    const gainIn = o && o.gain != null ? o.gain : 1;
    if (gainIn <= 0) return null;
    const s = c.createBufferSource();
    s.buffer = list[idx];
    let rate = (o && o.rate) || 1;
    rate *= 0.96 + 0.08 * ((idx * 0.618 + (o && o.seed != null ? (o.seed % 97) / 97 : Math.random())) % 1);
    // сильный удар звучит чуть ярче
    if (name === 'bodyHit') rate *= 0.9 + 0.2 * Math.min(1, gainIn);
    s.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = IMPACT_GAIN[name] * Math.min(gainIn, 2);
    s.connect(g);
    if (o && o.pos) {
      const p = this._panner(o.pos, 1);
      g.connect(p); p.connect(this._sfx);
      this._track(s, [s, g, p]);
    } else {
      g.connect(this._sfx);
      this._track(s, [s, g]);
    }
    s.start();
    return s;
  }

  // ---- чека ----
  _scrapeStart() {
    const sc = this._sc;
    if (!sc || sc.on) return;
    sc.on = true;
    const t = this.ctx.currentTime;
    // отменяем отложенное выключение от недавнего stop()
    if (sc.node) { sc.aP.cancelScheduledValues(t); sc.aP.setValueAtTime(1, t); }
    sc.g.gain.cancelScheduledValues(t);
    sc.g.gain.setTargetAtTime(sc.node ? 0.7 : 0, t, 0.01);
  }
  _scrapeSet(v, n, pos) {
    const sc = this._sc;
    if (!sc || !sc.on) return;
    const t = this.ctx.currentTime;
    if (sc.node) {
      sc.vP.setTargetAtTime(v, t, 0.008);
      sc.nP.setTargetAtTime(n, t, 0.008);
    } else {
      sc.g.gain.setTargetAtTime(Math.min(0.4, Math.abs(v) * n * 2), t, 0.02);
    }
    if (pos) setPos(sc.pan, pos);
  }
  _scrapeStop() {
    const sc = this._sc;
    if (!sc || !sc.on) return;
    sc.on = false;
    const t = this.ctx.currentTime;
    sc.g.gain.cancelScheduledValues(t);
    sc.g.gain.setTargetAtTime(0, t, 0.015);
    if (sc.node) {
      sc.vP.setTargetAtTime(0, t, 0.01);
      sc.aP.setValueAtTime(0, t + 0.06);
    }
  }

  // ---- свист рычага ----
  _whooshStart() {
    const c = this.ctx;
    if (!c || this._wh) return;
    const src = c.createBufferSource(); src.buffer = this._noise(); src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 1.6;
    const g = c.createGain(); g.gain.value = 0;
    const pan = this._panner(null, 1);
    src.connect(bp); bp.connect(g); g.connect(pan); pan.connect(this._sfx);
    src.start(c.currentTime, Math.random() * 1.5);
    this._track(src, [src, bp, g, pan]);
    this._wh = { src, bp, g, pan };
  }
  _whooshSet(speed, pos) {
    const w = this._wh;
    if (!w) return;
    const t = this.ctx.currentTime, s = Math.min(1, Math.max(0, speed) / 12);
    w.bp.frequency.setTargetAtTime(350 + 3200 * s * s, t, 0.03);
    w.g.gain.setTargetAtTime(0.5 * s * Math.sqrt(s), t, 0.03);
    if (pos) setPos(w.pan, pos);
  }
  _whooshStop() {
    const w = this._wh;
    if (!w) return;
    this._wh = null;
    const t = this.ctx.currentTime;
    w.g.gain.cancelScheduledValues(t);
    w.g.gain.setTargetAtTime(0, t, 0.015);
    w.src.stop(t + 0.08);
  }

  // ---- замедлитель ----
  _fuseStart(pos, duration) {
    const c = this.ctx;
    if (!c) return;
    this._fuseStop();
    const b = this._fuseBuf();
    const src = c.createBufferSource(); src.buffer = b; src.loop = true;
    const g = c.createGain();
    const pan = this._panner(pos, 1);
    src.connect(g); g.connect(pan); pan.connect(this._sfx);
    const t = c.currentTime, lvl = 0.35;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(lvl, t + 0.04);
    src.start(t, Math.random() * b.duration);
    if (duration > 0) {
      g.gain.setValueAtTime(lvl, t + Math.max(0.05, duration - 0.05));
      g.gain.linearRampToValueAtTime(0, t + Math.max(0.1, duration));
      src.stop(t + Math.max(0.1, duration) + 0.02);
    }
    this._track(src, [src, g, pan]);
    const fu = { src, g, pan };
    const end = src.onended;
    src.onended = () => { end(); if (this._fu === fu) this._fu = null; };
    this._fu = fu;
  }
  _fuseStop() {
    const f = this._fu;
    if (!f) return;
    this._fu = null;
    const t = this.ctx.currentTime;
    f.g.gain.cancelScheduledValues(t);
    f.g.gain.setValueAtTime(f.g.gain.value, t);
    f.g.gain.linearRampToValueAtTime(0, t + 0.05);
    try { f.src.stop(t + 0.06); } catch (e) { /* уже */ }
  }

  // ---- хлопок ----
  blast(kind, o = {}) {
    const c = this.ctx;
    if (!c || (kind !== 'm67' && kind !== 'm84')) return null;
    const seed = o.seed != null ? o.seed >>> 0 : (Math.random() * 4294967296) >>> 0;
    const buf = this._blastBuffer(kind, seed);
    this._last[kind] = buf;
    const pos = o.pos, lp = this._lp;
    const r = pos ? Math.max(0.3, Math.hypot(pos.x - lp.x, pos.y - lp.y, pos.z - lp.z)) : 3;
    const occ = Math.min(1, Math.max(0, o.occlusion || 0));
    const delay = o.delay === false ? 0 : r / C_SOUND;
    const t0 = c.currentTime + 0.005 + delay;
    const base = kind === 'm84' ? 1.0 : 0.85;

    const src = c.createBufferSource(); src.buffer = buf;
    const split = c.createChannelSplitter(3);
    const dryG = c.createGain(), lpf = c.createBiquadFilter(), merge = c.createChannelMerger(2), wetG = c.createGain();
    // поглощение верхов воздухом: ~20 кГц на 1 м → ~4 кГц на 30 м
    lpf.type = 'lowpass'; lpf.Q.value = -3.01;
    lpf.frequency.value = Math.max(300, Math.min(20000, 20000 * Math.pow(r, -0.473)) * (1 - 0.85 * occ));
    dryG.gain.value = base * (2 / (2 + r)) * (1 - 0.75 * occ);
    wetG.gain.value = base * 0.7 * (0.6 + 0.4 * 2 / (2 + r)) * (1 - 0.3 * occ);
    src.connect(split);
    split.connect(dryG, 0); dryG.connect(lpf);
    const nodes = [src, split, dryG, lpf, merge, wetG];
    if (pos) { const p = this._panner(pos, 0); lpf.connect(p); p.connect(this._sfx); nodes.push(p); }
    else lpf.connect(this._sfx);
    split.connect(merge, 1, 0); split.connect(merge, 2, 1); merge.connect(wetG); wetG.connect(this._sfx);
    src.start(t0);
    const h = { t0, stop: () => { try { src.stop(); } catch (e) { /* уже */ } } };
    this._track(src, nodes);
    const end = src.onended;
    src.onended = () => { end(); this._active.delete(h); };
    this._active.add(h);

    if (kind === 'm84') {
      const I = o.intensity != null ? Math.min(1, Math.max(0, o.intensity))
        : Math.min(1, 6 / (r + 1)) * (1 - 0.6 * occ);
      if (I > 0.02) this._deafen(t0 + 64 / buf.sampleRate, I);
    }
    return h;
  }

  // Заглушение слуха: первые ~30 мс хлопка проходят, затем срез падает и медленно восстанавливается.
  _deafen(tOn, I) {
    const c = this.ctx, f = this._muffle.frequency, dg = this._duck.gain, now = c.currentTime;
    const D = 10 + 10 * I, fmin = 4000 * Math.pow(800 / 4000, I), hold = 0.3 + 0.5 * I, ts = tOn + 0.03;
    for (const prm of [f, dg]) {
      if (prm.cancelAndHoldAtTime) prm.cancelAndHoldAtTime(now);
      else { const v = prm.value; prm.cancelScheduledValues(now); prm.setValueAtTime(v, now); }
    }
    f.setTargetAtTime(fmin, ts, 0.006);
    const cv = this._curve, n = cv.length, lo = Math.log(fmin), hi = Math.log(18000), nrm = 1 / (1 - Math.exp(-3));
    for (let i = 0; i < n; i++) cv[i] = Math.exp(lo + (hi - lo) * (1 - Math.exp(-3 * i / (n - 1))) * nrm);
    f.setValueCurveAtTime(cv, ts + hold, D);
    dg.setTargetAtTime(1 - 0.35 * I, ts, 0.01);
    dg.setTargetAtTime(1, ts + hold, D / 4);
    if (this._tinnitusOn) this._startTinnitus(tOn + 0.15, I);
  }

  // Звон — узкополосный шум с медленно блуждающим центром, не синус.
  _startTinnitus(t, I) {
    this._stopTinnitus();
    const c = this.ctx, len = 13;
    const src = c.createBufferSource(); src.buffer = this._noise(); src.loop = true;
    const bp1 = c.createBiquadFilter(), bp2 = c.createBiquadFilter(), g = c.createGain();
    bp1.type = bp2.type = 'bandpass'; bp1.Q.value = 30; bp2.Q.value = 12;
    const fc = 3500 + Math.random() * 1000, w = this._wander;
    let x = 0;
    for (let i = 0; i < w.length; i++) { x = x * 0.85 + (Math.random() * 2 - 1) * 60; w[i] = fc + x; }
    bp1.frequency.setValueCurveAtTime(w, t, len);
    bp2.frequency.setValueCurveAtTime(w, t, len);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * I, t + 0.4);
    g.gain.setTargetAtTime(0, t + 0.6, 3);
    src.connect(bp1); bp1.connect(bp2); bp2.connect(g); g.connect(this._comp);
    src.start(t, Math.random()); src.stop(t + len);
    const h = { src, g };
    this._track(src, [src, bp1, bp2, g]);
    const end = src.onended;
    src.onended = () => { end(); if (this._tinn === h) this._tinn = null; };
    this._tinn = h;
  }
  _stopTinnitus() {
    const h = this._tinn;
    if (!h) return;
    this._tinn = null;
    const t = this.ctx.currentTime;
    h.g.gain.cancelScheduledValues(t);
    h.g.gain.setTargetAtTime(0, t, 0.05);
    try { h.src.stop(t + 0.3); } catch (e) { /* уже */ }
  }

  // Слоу-мо: тот же буфер на малой скорости → низкий гул. slow — скорость (0.1) или кратность (10).
  replay(kind, slow = 0.1) {
    const c = this.ctx;
    if (!c) return null;
    const buf = this._last[kind] || this._blastBuffer(kind, 0);
    const rate = Math.min(1, Math.max(0.03, slow > 1 ? 1 / slow : slow));
    const src = c.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    const split = c.createChannelSplitter(3), wet = c.createGain(), sum = c.createGain(), lpf = c.createBiquadFilter(), out = c.createGain();
    sum.channelCount = 1; sum.channelCountMode = 'explicit';
    wet.gain.value = 0.5;
    lpf.type = 'lowpass'; lpf.frequency.value = Math.min(4000, 9000 * rate + 300); lpf.Q.value = -3.01;
    out.gain.value = 0.9;
    src.connect(split); split.connect(sum, 0); split.connect(wet, 1); split.connect(wet, 2);
    wet.connect(sum); sum.connect(lpf); lpf.connect(out); out.connect(this._comp);
    src.start();
    const h = {
      duration: buf.duration / rate,
      stop: () => {
        const t = c.currentTime;
        out.gain.cancelScheduledValues(t); out.gain.setTargetAtTime(0, t, 0.03);
        try { src.stop(t + 0.15); } catch (e) { /* уже */ }
      },
    };
    this._track(src, [src, split, wet, sum, lpf, out]);
    const end = src.onended;
    src.onended = () => { end(); this._active.delete(h); };
    this._active.add(h);
    return h;
  }

  setMuted(b) {
    this._muted = !!b;
    if (!this.ctx) return;
    const t = this.ctx.currentTime, g = this._master.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(this._muted ? 0 : 1, t, 0.05);
  }

  setTinnitus(b) {
    this._tinnitusOn = !!b;
    if (!b && this.ctx) this._stopTinnitus();
  }

  suspend() { return this.ctx ? this.ctx.suspend().catch(() => {}) : Promise.resolve(); }
  resume() { return this.ctx ? this.ctx.resume().catch(() => {}) : Promise.resolve(); }

  stopAll() {
    if (!this.ctx) return;
    this._scrapeStop(); this._whooshStop(); this._fuseStop(); this._stopTinnitus();
    for (const h of Array.from(this._active)) h.stop();
    this._active.clear();
    const t = this.ctx.currentTime;
    for (const [prm, v] of [[this._muffle.frequency, 18000], [this._duck.gain, 1]]) {
      prm.cancelScheduledValues(0);
      prm.setTargetAtTime(v, t, 0.05);
    }
  }

  get stats() {
    const s = this._stats;
    s.nodes = this._live + this._persist;
    s.variants = this._variants.m67.length + this._variants.m84.length;
    return s;
  }
}

// Только для dev/audio_test.html: офлайн-проверки спектра.
export const __test = { WORKLET_SRC, synthBlast, synthBlastGen, synthFuse, IMPACTS, IMPACT_LEN };
