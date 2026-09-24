// M67: гладкая стальная сфера Ø63,5 мм + запал M213 (рычаг, чека с кольцом, предохранительный клип).
// Карты MeshStandardMaterial запекаются на GPU процедурно (MRT: albedo / normal / ORM).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const R = 0.03175;
const HOLE_R = 0.0098;                 // отверстие под запал в верхушке корпуса
const COLLAR_Y = 0.0328;               // верх бурта горловины
const FUZE_BASE_Y = 0.0318;
const PIN_C = new THREE.Vector3(0.0114, 0.0470, 0);   // ось чеки сквозь ушки запала
const HINGE = new THREE.Vector3(-0.0100, 0.0532, 0);  // крюк рычага под губой запала
const THK = 0.0009;                    // толщина рычага
const CROWN = 0.0010;                  // выпуклость рычага поперёк
const PIN_TRAVEL = 0.024;
const CLIP_Y = 0.0395;

// Атлас металла: полосы по v (u — вся ширина). Держать в согласии с шейдером (подставляются как #define).
const MV = {
  FZ: [0.02, 0.30], FS: [0.32, 0.37], PN: [0.39, 0.43], RG: [0.45, 0.49], CL: [0.51, 0.55],
  LO: [0.58, 0.74], LI: [0.76, 0.90], LE: [0.92, 0.98],
};

const QI = { low: 0, med: 1, high: 2 };

// ---------------------------------------------------------------- утилиты геометрии

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Сетка nu×nv; pos(u, v, out). expect(u, v, out) — желаемая наружная нормаль для проверки намотки.
function gridGeom(nu, nv, pos, rect, expect) {
  const n = (nu + 1) * (nv + 1);
  const P = new Float32Array(n * 3), UV = new Float32Array(n * 2), idx = [];
  const p = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const k = j * (nu + 1) + i, u = i / nu, v = j / nv;
    pos(u, v, p);
    P.set([p.x, p.y, p.z], k * 3);
    UV[k * 2] = lerp(rect[0], rect[2], u);
    UV[k * 2 + 1] = lerp(rect[1], rect[3], v);
  }
  let flip = false;
  if (expect) {
    const i = nu >> 1, j = nv >> 1, w = nu + 1;
    const A = j * w + i, B = A + 1, D = A + w + 1;
    _a.fromArray(P, A * 3); _b.fromArray(P, B * 3).sub(_a); _c.fromArray(P, D * 3).sub(_a);
    _n.crossVectors(_b, _c);
    expect((i + 0.5) / nu, (j + 0.5) / nv, p);
    flip = _n.dot(p) < 0;
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    if (flip) idx.push(a, d, b, a, c, d); else idx.push(a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Тело вращения вокруг +Y. strips — массивы [r, y]; внутри полосы нормали сглажены, между — жёсткий излом.
// φ = (u − 0.5)·2π, u = 0.5 смотрит в +Z (так же, как у корпуса). v — по длине дуги профиля.
function latheGeom(strips, seg, v0, v1, inward = false) {
  let total = 0;
  const lens = strips.map((s) => {
    const L = [0];
    for (let i = 1; i < s.length; i++) L.push(L[i - 1] + Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]));
    return L;
  });
  const offs = [];
  for (const L of lens) { offs.push(total); total += L[L.length - 1]; }
  const P = [], N = [], UV = [], idx = [], ranges = [];
  let base = 0;
  strips.forEach((s, si) => {
    const vs = [];
    for (let j = 0; j < s.length; j++) {
      let nr = 0, ny = 0;
      for (const k of [j - 1, j]) {
        if (k < 0 || k + 1 >= s.length) continue;
        const dr = s[k + 1][0] - s[k][0], dy = s[k + 1][1] - s[k][1], l = Math.hypot(dr, dy) || 1;
        nr += dy / l; ny += -dr / l;
      }
      const l = Math.hypot(nr, ny) || 1; nr /= l; ny /= l;
      if (inward) { nr = -nr; ny = -ny; }
      const v = lerp(v0, v1, (offs[si] + lens[si][j]) / total);
      vs.push(v);
      for (let i = 0; i <= seg; i++) {
        const u = i / seg, ph = (u - 0.5) * Math.PI * 2, sp = Math.sin(ph), cp = Math.cos(ph);
        P.push(s[j][0] * sp, s[j][1], s[j][0] * cp);
        N.push(nr * sp, ny, nr * cp);
        UV.push(u, v);
      }
    }
    ranges.push([vs[0], vs[vs.length - 1]]);
    for (let j = 0; j < s.length - 1; j++) for (let i = 0; i < seg; i++) {
      const a = base + j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      if (inward) idx.push(a, d, b, a, c, d); else idx.push(a, b, d, a, d, c);
    }
    base += s.length * (seg + 1);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(idx);
  g.userData.ranges = ranges;
  return g;
}

// Нормализует существующие uv в прямоугольник атласа.
function remapUV(g, rect) {
  const uv = g.attributes.uv;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const du = u1 - u0 || 1, dv = v1 - v0 || 1;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, lerp(rect[0], rect[2], (uv.getX(i) - u0) / du), lerp(rect[1], rect[3], (uv.getY(i) - v0) / dv));
  }
  return g;
}

function merge(list) {
  const flat = list.map((g) => {
    const x = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(x.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') x.deleteAttribute(k);
    x.clearGroups();
    return x;
  });
  const m = mergeGeometries(flat, false);
  for (const g of list) g.dispose();
  for (const g of flat) g.dispose();
  return m;
}

// ---------------------------------------------------------------- корпус

function bodyGeometry(q) {
  const nu = [36, 56, 76][q], nr = [20, 30, 38][q];
  const th0 = Math.asin(HOLE_R / R);
  let th = [];
  for (let i = 0; i <= nr; i++) th.push(Math.PI - (Math.PI - th0) * i / nr);
  // сгущение колец у сварного шва на экваторе
  for (const d of [-0.05, -0.028, -0.016, -0.007, 0, 0.007, 0.016, 0.028, 0.05]) th.push(Math.PI / 2 + d);
  th.sort((a, b) => b - a);
  th = th.filter((t, i) => i === 0 || th[i - 1] - t > 0.004 || i === th.length - 1);

  const bead = (t) => { const w = Math.abs(t - Math.PI / 2) * R / 0.0009; return w < 1 ? 0.00011 * (1 - w * w) ** 2 : 0; };
  const rows = th.map((t) => {
    const r = R + bead(t), dr = (bead(t + 1e-4) - bead(t - 1e-4)) / 2e-4;
    // нормаль = r·r̂ − r'·θ̂ в плоскости меридиана
    const st = Math.sin(t), ct = Math.cos(t);
    let nxz = r * st - dr * ct, ny = r * ct + dr * st;
    const l = Math.hypot(nxz, ny); nxz /= l; ny /= l;
    return { r: r * st, y: r * ct, nr: nxz, ny, v: 1 - t / Math.PI };
  });
  const y0 = rows[rows.length - 1].y;
  const collar = [
    { r: HOLE_R, y: y0, nr: 1, ny: 0, v: 0.903 },
    { r: HOLE_R, y: COLLAR_Y - 0.0006, nr: 1, ny: 0, v: 0.93 },
    { r: HOLE_R - 0.0003, y: COLLAR_Y - 0.0001, nr: 0.6, ny: 0.8, v: 0.95 },
    { r: HOLE_R - 0.0008, y: COLLAR_Y, nr: 0, ny: 1, v: 0.965 },
    { r: 0.0080, y: COLLAR_Y, nr: 0, ny: 1, v: 0.995 },
  ];
  const P = [], N = [], UV = [], idx = [];
  let base = 0;
  for (const strip of [rows, collar]) {
    for (const row of strip) for (let i = 0; i <= nu; i++) {
      const u = i / nu, ph = (u - 0.5) * Math.PI * 2, sp = Math.sin(ph), cp = Math.cos(ph);
      P.push(row.r * sp, row.y, row.r * cp);
      N.push(row.nr * sp, row.ny, row.nr * cp);
      UV.push(u, row.v);
    }
    for (let j = 0; j < strip.length - 1; j++) for (let i = 0; i < nu; i++) {
      const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
    base += strip.length * (nu + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return { geom: g, vHole: rows[rows.length - 1].v };
}

// ---------------------------------------------------------------- запал M213

const FUZE_STRIPS = [
  [[0.0079, FUZE_BASE_Y], [0.0079, 0.0330]],                                        // резьба (внутри горловины)
  [[0.0079, 0.0330], [0.0104, 0.0330]],
  [[0.0104, 0.0330], [0.0106, 0.0333], [0.0106, 0.0349], [0.0104, 0.0352]],          // фланец на бурте корпуса
  [[0.0104, 0.0352], [0.0095, 0.0353]],
  [[0.0095, 0.0353], [0.0095, 0.0518], [0.0093, 0.0526], [0.0088, 0.0533], [0.0082, 0.0537]],
  [[0.0082, 0.0537], [0.0078, 0.0539], [0.0040, 0.0539], [0.0, 0.0539]],
];
const BORE_R = 0.0033, BORE_TOP = 0.0527;

function fuzeGeometry(q) {
  const seg = [20, 32, 44][q];
  const lathe = latheGeom(FUZE_STRIPS, seg, MV.FZ[0], MV.FZ[1]);
  const ranges = lathe.userData.ranges;
  const fs = MV.FS;
  const bore = remapUV(latheGeom([[[BORE_R, FUZE_BASE_Y], [BORE_R, BORE_TOP]], [[BORE_R, BORE_TOP], [0, BORE_TOP]]], 16, 0, 1, true),
    [0.70, fs[0], 0.99, fs[1]]);

  // ушки под чеку (±Z), скруглены вокруг оси чеки
  const lug = new THREE.Shape();
  lug.moveTo(0.0070, 0.0432);
  lug.lineTo(PIN_C.x, 0.0432);
  lug.absarc(PIN_C.x, PIN_C.y, 0.0038, -Math.PI / 2, Math.PI / 2, false);
  lug.lineTo(0.0070, PIN_C.y + 0.0038);
  lug.lineTo(0.0070, 0.0432);
  const lugs = [0.0050, -0.0062].map((z, i) => {
    const g = new THREE.ExtrudeGeometry(lug, { depth: 0.0012, bevelEnabled: false, curveSegments: [4, 6, 8][q] });
    g.translate(0, 0, z);
    return remapUV(g, [0.02 + i * 0.2, fs[0], 0.2 + i * 0.2, fs[1]]);
  });
  // губа под крюк рычага (−X) и головка ударника под верхом рычага
  const lip = new THREE.BoxGeometry(0.0016, 0.0012, 0.0090).translate(-0.0098, 0.0529, 0);
  const striker = new THREE.BoxGeometry(0.0120, 0.0007, 0.0068).translate(0.0012, 0.05425, 0);
  remapUV(lip, [0.42, fs[0], 0.52, fs[1]]);
  remapUV(striker, [0.54, fs[0], 0.68, fs[1]]);
  const g = merge([lathe, bore, ...lugs, lip, striker]);
  return { geom: g, ranges };
}

// Сечение стенки запала плоскостью x = 0 (крышка разреза).
function sectionCapGeometry() {
  const outer = [];
  for (const s of FUZE_STRIPS) for (const p of s) {
    const last = outer[outer.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) outer.push(p);
  }
  const sh = new THREE.Shape();
  sh.moveTo(outer[0][0], outer[0][1]);
  for (let i = 1; i < outer.length; i++) sh.lineTo(outer[i][0], outer[i][1]);
  for (let i = outer.length - 2; i >= 0; i--) sh.lineTo(-outer[i][0], outer[i][1]);
  sh.lineTo(-BORE_R, FUZE_BASE_Y);
  sh.lineTo(-BORE_R, BORE_TOP);
  sh.lineTo(BORE_R, BORE_TOP);
  sh.lineTo(BORE_R, FUZE_BASE_Y);
  const g = new THREE.ShapeGeometry(sh);
  g.rotateY(-Math.PI / 2);  // плоскость XY → x = 0, лицом к −X
  g.translate(0.00003, 0, 0);
  return g;
}

// ---------------------------------------------------------------- рычаг

function leverCurve() {
  const pts = [
    [-0.0096, 0.0517], [-0.0110, 0.0521], [-0.0114, 0.0536], [-0.0102, 0.0552], [-0.0074, 0.0556],
    [0.0000, 0.0556], [0.0080, 0.0556], [0.0120, 0.0550], [0.0140, 0.0530], [0.0148, 0.0500],
    [0.0150, 0.0455], [0.0153, 0.0405],
  ];
  const Rl = R + 0.0026;
  for (let k = 0; k <= 8; k++) {
    const t = lerp(0.50, Math.PI / 2 + 0.08, k / 8);
    pts.push([Rl * Math.sin(t), Rl * Math.cos(t)]);
  }
  return new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], 0)), false, 'centripetal');
}

function leverWidth(t, tPin) {
  const hook = sstep(0.0, 0.07, t);
  return lerp(0.0092, 0.0160, hook) - 0.0055 * sstep(tPin + 0.04, 1.0, t);
}

function leverGeometry(q, curve) {
  const nt = [28, 48, 72][q], ns = [3, 6, 8][q];
  const T = [], C = [], Nn = [];
  for (let i = 0; i <= nt; i++) {
    const t = i / nt, c = curve.getPointAt(t), tg = curve.getTangentAt(t);
    T.push(t); C.push(c); Nn.push(new THREE.Vector3(-tg.y, tg.x, 0));
  }
  // параметр ближайшей к оси чеки точки — там у рычага щёчки
  let tPin = 0, best = Infinity;
  for (let i = 0; i <= nt; i++) { const d = C[i].distanceToSquared(PIN_C); if (d < best) { best = d; tPin = T[i]; } }
  const at = (t, out) => {
    const f = Math.min(nt - 1e-6, t * nt), i = Math.floor(f), s = f - i;
    out.c = _a.copy(C[i]).lerp(C[i + 1], s);
    out.n = _b.copy(Nn[i]).lerp(Nn[i + 1], s).normalize();
    return out;
  };
  const tmp = {};
  // поверхность: side = ±1 (наружу/внутрь), s ∈ [−1, 1] поперёк; s = +1 → +Z
  const surf = (t, s, side, out) => {
    at(t, tmp);
    const w = leverWidth(t, tPin), lift = CROWN * (1 - s * s) + side * THK * 0.5;
    return out.set(tmp.c.x + tmp.n.x * lift, tmp.c.y + tmp.n.y * lift, s * w * 0.5);
  };
  const nrm = (t, out) => { at(t, tmp); return out.copy(tmp.n); };
  const parts = [];
  // наружная: u — вдоль, v — поперёк, v растёт к −Z (иначе надписи зеркальны)
  parts.push(gridGeom(nt, ns, (u, v, o) => surf(u, 1 - 2 * v, 1, o), [0.01, MV.LO[0], 0.99, MV.LO[1]], (u, v, o) => nrm(u, o)));
  parts.push(gridGeom(nt, ns, (u, v, o) => surf(u, 2 * v - 1, -1, o), [0.01, MV.LI[0], 0.99, MV.LI[1]], (u, v, o) => nrm(u, o).negate()));
  const le = MV.LE, eh = (le[1] - le[0]) / 4;
  [1, -1].forEach((s, k) => {
    parts.push(gridGeom(nt, 1, (u, v, o) => surf(u, s, v * 2 - 1, o), [0.01, le[0] + k * eh, 0.99, le[0] + (k + 1) * eh * 0.8],
      (u, v, o) => o.set(0, 0, s)));
  });
  [0, 1].forEach((t, k) => {
    parts.push(gridGeom(ns, 1, (u, v, o) => surf(t, 1 - 2 * u, v * 2 - 1, o), [0.01 + k * 0.1, le[0] + 2 * eh, 0.09 + k * 0.1, le[0] + 2.8 * eh],
      (u, v, o) => o.copy(curve.getTangentAt(t)).multiplyScalar(t === 0 ? -1 : 1)));
  });
  // щёчки рычага по бокам ушек запала — сквозь них проходит чека
  const fl = new THREE.Shape();
  fl.moveTo(0.0076, 0.0552);
  fl.lineTo(0.0120, 0.0548);
  fl.quadraticCurveTo(0.0146, 0.0535, 0.0149, 0.0490);
  fl.lineTo(0.0149, PIN_C.y);
  fl.absarc(PIN_C.x, PIN_C.y, 0.0035, 0, -Math.PI, true);
  fl.lineTo(0.0076, 0.0552);
  const wPin = leverWidth(tPin, tPin);
  [1, -1].forEach((s, k) => {
    const g = new THREE.ExtrudeGeometry(fl, { depth: 0.0008, bevelEnabled: false, curveSegments: [4, 6, 8][q] });
    g.translate(0, 0, s > 0 ? wPin * 0.5 - 0.0009 : -wPin * 0.5 + 0.0001);
    parts.push(remapUV(g, [0.22 + k * 0.2, le[0] + 3 * eh, 0.40 + k * 0.2, le[1]]));
  });
  const g = merge(parts);
  g.translate(-HINGE.x, -HINGE.y, -HINGE.z);
  return { geom: g, tPin };
}

// ---------------------------------------------------------------- чека, кольцо, клип

const PIN_Z0 = -0.0088, PIN_Z1 = 0.0100, LEG_R = 0.0005, EYE_R = 0.0011, EYE_Z = 0.0110;
const RING_RM = 0.0115, RING_W = 0.0009, RING_TILT = 0.95;

function pinGeometry(q) {
  const rs = [6, 8, 10][q], pn = MV.PN;
  const legs = [1, -1].map((s, k) => {
    const g = new THREE.CylinderGeometry(LEG_R, LEG_R, PIN_Z1 - PIN_Z0, rs, 1, true);
    g.rotateX(Math.PI / 2).translate(0, s * LEG_R, (PIN_Z0 + PIN_Z1) / 2);
    return remapUV(g, [0.02 + k * 0.3, pn[0], 0.30 + k * 0.3, pn[1]]);
  });
  const a1 = Math.PI - Math.asin(LEG_R / EYE_R), pts = [];
  for (let k = 0; k <= 16; k++) {
    const a = a1 - (k / 16) * 2 * a1;
    pts.push(new THREE.Vector3(0, EYE_R * Math.sin(a), EYE_Z + EYE_R * Math.cos(a)));
  }
  const eye = remapUV(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), [8, 12, 16][q], LEG_R, rs, false), [0.64, pn[0], 0.98, pn[1]]);
  const tip = new THREE.CylinderGeometry(LEG_R * 0.8, LEG_R, 0.0038, rs, 1, false);
  tip.rotateX(Math.PI / 2).translate(0, 0, -0.0019);
  remapUV(tip, [0.02, pn[0], 0.3, pn[1]]);
  return { legs: merge([...legs, eye]), tip };
}

function ringGeometry(q) {
  const g = new THREE.TorusGeometry(RING_RM, RING_W, [6, 8, 10][q], [24, 40, 56][q]);
  remapUV(g, [0.01, MV.RG[0], 0.99, MV.RG[1]]);
  const a = new THREE.Vector3(0, -Math.sin(RING_TILT), Math.cos(RING_TILT));  // от ушка к центру кольца
  const x = new THREE.Vector3(1, 0, 0);
  const m = new THREE.Matrix4().makeBasis(a, x, new THREE.Vector3().crossVectors(a, x));
  m.setPosition(a.clone().multiplyScalar(RING_RM));
  g.applyMatrix4(m);
  return { geom: g, center: a.multiplyScalar(RING_RM) };
}

function clipCurve(curve, tPin) {
  // рычаг на высоте клипа
  let best = Infinity, c = null, t0 = 0;
  for (let i = 0; i <= 400; i++) {
    const t = i / 400, p = curve.getPointAt(t), d = Math.abs(p.y - CLIP_Y);
    if (t > tPin && d < best) { best = d; c = p; t0 = t; }
  }
  const x0 = c.x, hw = leverWidth(t0, tPin) * 0.5, y = CLIP_Y, rn = 0.0095 + 0.00058, yn = CLIP_Y - 0.0002;
  const pts = [
    [x0 + THK * 0.5 + CROWN + 0.0006, y, 0],
    [x0 + THK * 0.5 + CROWN * 0.55 + 0.0006, y, -hw * 0.66],
    [x0 + 0.0009, y, -hw - 0.0007],
    [x0 - 0.0016, y - 0.0001, -hw - 0.0009],
    [x0 - 0.0045, yn, -0.0086],
  ];
  for (let k = 0; k <= 10; k++) {
    const ph = lerp(-1.15, -Math.PI * 2 + 1.15, k / 10);
    pts.push([rn * Math.cos(ph), yn, rn * Math.sin(ph)]);
  }
  pts.push([x0 - 0.0045, yn, 0.0086], [x0 - 0.0016, y - 0.0001, hw + 0.0009], [x0 + 0.0009, y, hw + 0.0007],
    [x0 + THK * 0.5 + CROWN * 0.55 + 0.0006, y, hw * 0.66]);
  return {
    curve: new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])), true, 'centripetal'),
    pivot: new THREE.Vector3(pts[0][0], pts[0][1], 0),
  };
}

// ---------------------------------------------------------------- надписи (canvas → карта для запечки)

function erode(x, n, rmin, rmax, area, rnd) {
  x.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < n; i++) {
    const px = area[0] + rnd() * (area[2] - area[0]), py = area[1] + rnd() * (area[3] - area[1]);
    const r = rmin + rnd() * (rmax - rmin);
    x.globalAlpha = 0.25 + rnd() * 0.75;
    x.beginPath();
    x.ellipse(px, py, r, r * (0.35 + rnd() * 0.9), rnd() * 3.14, 0, Math.PI * 2);
    x.fill();
  }
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
}

const FONT = 'Arial Narrow, Arial, Helvetica, Liberation Sans, sans-serif';

// Корпус: равнопромежуточная развёртка, u = 0.5 — сторона +Z. Жёлтая трафаретная маркировка ВВ.
function makeBodyDecal(W, vHole, rnd) {
  const H = W / 2, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const yv = (v) => (1 - v) * H;
  const pxmm = H / (Math.PI * R * 1000);
  const YEL = 'rgba(214,184,70,';
  // жёлтый поясок вокруг гнезда запала
  x.fillStyle = YEL + '0.92)';
  x.fillRect(0, yv(vHole - 0.012), W, yv(vHole - 0.040) - yv(vHole - 0.012));
  erode(x, W * 0.35, 1, 4 * W / 2048, [0, yv(vHole - 0.008), W, yv(vHole - 0.044)], rnd);
  const lines = [
    ['GRENADE HAND FRAG', 0.700, 3.2], ['DELAY  M67', 0.652, 3.2], ['LOT MA-24J017-006', 0.608, 2.4],
  ];
  x.textAlign = 'center';
  x.textBaseline = 'alphabetic';
  for (const [txt, v, mm] of lines) {
    const st = Math.sin(Math.PI * (1 - v));
    x.save();
    x.translate(W * 0.5, yv(v));
    x.scale(1 / st, 1);  // компенсация сжатия развёртки по широте
    x.fillStyle = YEL + '0.95)';
    x.font = `bold ${Math.round(mm * pxmm / 0.72)}px ${FONT}`;
    x.fillText(txt, 0, 0);
    x.restore();
  }
  // перемычки трафарета
  x.globalCompositeOperation = 'destination-out';
  x.fillStyle = '#000';
  for (const v of [0.712, 0.664, 0.617]) x.fillRect(0, yv(v), W, Math.max(1, W / 1400));
  x.globalCompositeOperation = 'source-over';
  erode(x, W * 0.3, 0.8, 3.5 * W / 2048, [W * 0.3, yv(0.74), W * 0.7, yv(0.57)], rnd);
  return c;
}

// Металл: штамповка (чёрное = выбитый знак) на рычаге и корпусе запала.
function makeMetalDecal(S, fz, rnd) {
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const x = c.getContext('2d');
  const yv = (v) => (1 - v) * S;
  x.textBaseline = 'middle';
  x.textAlign = 'center';
  x.fillStyle = 'rgba(8,8,8,0.95)';
  // рычаг, наружная сторона: u — вдоль (от крюка к концу), v — поперёк
  const lo = MV.LO, L = fz.leverLen, w = 0.016;
  const pxU = S * 0.98 / (L * 1000), pxV = S * (lo[1] - lo[0]) / (w * 1000);
  const stamp = (txt, u, v, mm) => {
    x.save();
    x.translate(S * (0.01 + 0.98 * u), yv(lerp(lo[0], lo[1], v)));
    x.scale(pxU / pxV, 1);
    x.font = `bold ${Math.round(mm * pxV / 0.72)}px ${FONT}`;
    x.fillText(txt, 0, 0);
    x.restore();
  };
  stamp('FUZE  M213   LOT  MA-24J-0613', fz.tStamp, 0.33, 1.7);
  stamp('DELAY 4\u20135.5 SEC', fz.tStamp, 0.68, 1.7);
  erode(x, S * 0.08, 0.5, 1.6 * S / 1024, [0, yv(lo[1]), S, yv(lo[0])], rnd);
  // корпус запала (+Z): «M213»
  const [m0, m1] = fz.mainV;
  const pxmmU = S / (2 * Math.PI * 0.0095 * 1000), pxmmV = S * (m1 - m0) / (fz.mainLen * 1000);
  x.save();
  x.textAlign = 'center';
  x.translate(S * 0.5, yv(lerp(m0, m1, 0.38)));
  x.scale(pxmmU / pxmmV, 1);
  x.font = `bold ${Math.round(1.6 * pxmmV / 0.72)}px ${FONT}`;
  x.fillText('M213', 0, 0);
  x.restore();
  // отверстие выхода газов капсюля
  x.beginPath();
  x.ellipse(S * 0.5, yv(fz.ventV), 0.45 * pxmmU, 0.45 * pxmmV, 0, 0, Math.PI * 2);
  x.fill();
  return c;
}

// ---------------------------------------------------------------- шейдеры запечки

const GLSL_NOISE = /* glsl */`
float h21(vec2 p){ p += uSeed * 17.13; vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p, float px){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  vec2 a = i, b = i + vec2(1.0,0.0), c = i + vec2(0.0,1.0), d = i + vec2(1.0,1.0);
  if (px > 0.5){ a.x = mod(a.x, px); b.x = mod(b.x, px); c.x = mod(c.x, px); d.x = mod(d.x, px); }
  return mix(mix(h21(a), h21(b), f.x), mix(h21(c), h21(d), f.x), f.y);
}
float fbm(vec2 p, float px, int oct){
  float s = 0.0, a = 0.5, t = 0.0;
  for (int i = 0; i < 5; i++){ if (i >= oct) break; s += a*vn(p, px); t += a; p *= 2.0; px *= 2.0; a *= 0.5; }
  return s / t;
}
vec3 srgb2lin(vec3 c){ return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045, c)); }
float scratch(vec2 uv, float f1, float f2){
  float a = vn(vec2(uv.x*f1, uv.y*f1*0.03), f1);
  float b = vn(vec2(uv.x*f2*0.03, uv.y*f2), f2*0.03);
  float br = fbm(uv*vec2(60.0,30.0), 60.0, 2);
  return clamp(smoothstep(0.94, 0.995, a)*br*1.6 + smoothstep(0.95, 0.999, b)*br*1.3, 0.0, 1.0);
}
`;

const BAKE_VS = /* glsl */`
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BAKE_HEAD = /* glsl */`
precision highp float;
in vec2 vUv;
uniform sampler2D uDecal;
uniform vec2 uRes;
uniform float uWear, uRust, uSmudge, uSeed;
#ifdef AUX
layout(location = 0) out vec4 oAux;
#else
uniform sampler2D uAux;
layout(location = 0) out vec4 oAlb;
layout(location = 1) out vec4 oNrm;
layout(location = 2) out vec4 oOrm;
#endif
// высота (м) в aux-цели: кодировка годится и для RGBA8, и для half float
float encH(float h){ return h * 3500.0 + 0.5; }
float decH(float x){ return (x - 0.5) / 3500.0; }
const float PI = 3.14159265;
const vec3 OLIVE = vec3(0.078, 0.086, 0.043);
const vec3 RUSTC = vec3(0.115, 0.036, 0.013);
`;

function bodyFS(vHole) {
  return BAKE_HEAD + GLSL_NOISE + /* glsl */`
const float R = ${R.toFixed(5)}, VH = ${vHole.toFixed(4)};
float seamM(vec2 uv){ return abs(uv.y - 0.5) * PI * R; }
float wellP(vec2 uv){ return smoothstep(VH - 0.06, VH, uv.y); }
float chipMask(vec2 uv){
  float zone = 0.8*exp(-seamM(uv)/0.0025) + 0.55*smoothstep(0.30, 0.03, uv.y) + 0.45*wellP(uv)
             + 0.5*smoothstep(0.5, 0.8, fbm(uv*vec2(8.0,4.0), 8.0, 3));
  float n = fbm(uv*vec2(170.0,85.0), 170.0, 4);
  float n2 = fbm(uv*vec2(40.0,20.0), 40.0, 3);
  float t = 0.86 - 0.24*uWear*(0.05 + 0.95*zone) - 0.05*n2;
  return smoothstep(t, t + 0.025, n);
}
float prints(vec2 uv){
  float s = 0.0;
  for (int i = 0; i < 3; i++){
    vec2 c = vec2(0.30 + 0.27*float(i), 0.47 + 0.09*float(i) - 0.04*float(i*i));
    vec2 d = (uv - c) * vec2(2.0, 1.0);
    float r = length(d);
    float ridge = 0.5 + 0.5*sin(r*1100.0 + 6.0*fbm(uv*vec2(50.0,25.0), 50.0, 2));
    s += smoothstep(0.045, 0.006, r) * (0.4 + 0.6*ridge);
  }
  return clamp(s, 0.0, 1.0);
}
float heightB(vec2 uv, float chip){
  float bm = 1.0 - smoothstep(0.0, 0.0011, seamM(uv));
  float h = bm * (0.00002 + 0.000008*sin(uv.x * PI * 2.0 * 230.0));      // рябь сварного шва
  h += (fbm(uv*vec2(900.0,450.0), 900.0, 2) - 0.5) * 0.000012;            // шагрень краски
  h -= smoothstep(0.70, 0.95, fbm(uv*vec2(14.0,7.0), 14.0, 3)) * 0.00005;  // мягкие вмятины
  h -= chip * 0.00005;
  h += texture(uDecal, uv).a * 0.000006;
  return h;
}
#ifdef AUX
void main(){ float c = chipMask(vUv); oAux = vec4(encH(heightB(vUv, c)), c, 0.0, 1.0); }
#else
void main(){
  vec2 uv = vUv;
  vec2 e = 1.0 / uRes;
  float st = max(sin(PI * uv.y), 0.08);
  vec4 a0 = texture(uAux, uv);
  float h0 = decH(a0.r), hx = decH(texture(uAux, uv + vec2(e.x, 0.0)).r), hy = decH(texture(uAux, uv + vec2(0.0, e.y)).r);
  vec2 dm = vec2(2.0*PI*R*st*e.x, PI*R*e.y);
  vec3 n = normalize(vec3((h0 - hx)/dm.x, (h0 - hy)/dm.y, 1.0));

  float chips = a0.g;
  float scr = scratch(uv, 560.0, 420.0) * (0.2 + 0.5*uWear);
  float bare = clamp(chips + scr*0.35, 0.0, 1.0);
  float mottle = fbm(uv*vec2(30.0,15.0), 30.0, 3);
  float dirt = smoothstep(0.35, 0.85, fbm(uv*vec2(16.0,8.0), 16.0, 3));
  float seamP = exp(-seamM(uv)/0.0012);
  float wp = wellP(uv);
  float rustN = smoothstep(0.42, 0.80, fbm(uv*vec2(60.0,30.0), 60.0, 3));
  float rust = clamp(uRust * (seamP*0.9 + wp*1.1 + chips*0.8 + 0.12) * rustN, 0.0, 1.0);
  vec4 dc = texture(uDecal, uv);
  float dca = dc.a * (1.0 - bare) * (1.0 - 0.4*rust);
  vec3 paint = OLIVE * (0.86 + 0.28*mottle);
  paint = mix(paint, srgb2lin(dc.rgb) * (0.82 + 0.3*mottle), dca);
  paint *= mix(1.0, 0.78, dirt*0.5);
  vec3 steel = vec3(0.20, 0.20, 0.21) * (0.8 + 0.4*mottle);
  vec3 albedo = mix(paint, steel, bare);
  albedo = mix(albedo, RUSTC * (0.7 + 0.6*rustN), rust);
  float pr = prints(uv) * uSmudge;
  float sm = smoothstep(0.42, 0.78, fbm(uv*vec2(9.0,4.5), 9.0, 3)) * uSmudge;
  float rough = mix(0.62 - 0.06*mottle + 0.10*dirt - 0.22*pr - 0.10*sm - 0.05*dca, 0.45 + 0.1*mottle, bare);
  rough = mix(rough, 0.92, rust);
  float metal = bare * (1.0 - rust);
  // тень под рычагом (+X, u = 0.75) и у горловины
  float du = abs(uv.x - 0.75) * 2.0 * PI * R * st;
  float under = exp(-pow(du/0.0085, 2.0)) * smoothstep(0.45, 0.50, uv.y) * (1.0 - smoothstep(VH - 0.01, VH + 0.02, uv.y));
  float ao = 1.0 - 0.38*under - 0.12*smoothstep(VH - 0.03, VH, uv.y) - 0.12*rust - 0.08*chips;
  ao *= 1.0 - 0.25*seamP;
  oAlb = vec4(clamp(albedo, 0.0, 1.0), 1.0);
  oNrm = vec4(n * 0.5 + 0.5, 1.0);
  oOrm = vec4(clamp(ao, 0.0, 1.0), clamp(rough, 0.04, 1.0), clamp(metal, 0.0, 1.0), 1.0);
}
#endif
`;
}

function metalFS(k) {
  const d = (n, v) => `const vec2 ${n} = vec2(${v[0].toFixed(4)}, ${v[1].toFixed(4)});`;
  return BAKE_HEAD + GLSL_NOISE + /* glsl */`
${d('FZ', MV.FZ)} ${d('FS', MV.FS)} ${d('PN', MV.PN)} ${d('RG', MV.RG)} ${d('CL', MV.CL)}
${d('LO', MV.LO)} ${d('LI', MV.LI)} ${d('LE', MV.LE)}
${d('THR', k.threadV)} ${d('MAIN', k.mainV)}
uniform float uMpt;
bool inR(float v, vec2 r){ return v >= r.x - 0.008 && v <= r.y + 0.008; }
float stampM(vec2 uv){ vec4 dc = texture(uDecal, uv); return step(dot(dc.rgb, vec3(0.333)), 0.2) * dc.a; }
float heightM(vec2 uv){
  float v = uv.y, h = 0.0;
  if (inR(v, FZ)){
    if (v >= THR.x && v <= THR.y){
      float f = fract((v - THR.x) / (THR.y - THR.x) * 6.0 - uv.x);
      h += 0.00012 * (1.0 - abs(2.0*f - 1.0));
    }
    h += sin(v * 5200.0) * 0.0000015 + (fbm(uv*vec2(260.0,540.0), 260.0, 2) - 0.5) * 0.000006;
    h -= stampM(uv) * 0.00004;
  } else if (v > LO.x - 0.01){
    h += (fbm(uv*vec2(300.0,300.0), 0.0, 2) - 0.5) * 0.000007;
    h -= stampM(uv) * 0.00005;
    h -= smoothstep(0.80, 0.86, fbm(uv*vec2(220.0,220.0), 0.0, 3)) * 0.00002;
  } else {
    h += (fbm(uv*vec2(3.0,400.0), 0.0, 2) - 0.5) * 0.000004;
  }
  return h;
}
#ifdef AUX
void main(){ oAux = vec4(encH(heightM(vUv)), 0.0, 0.0, 1.0); }
#else
void main(){
  vec2 uv = vUv;
  vec2 e = 1.0 / uRes;
  float h0 = decH(texture(uAux, uv).r), hx = decH(texture(uAux, uv + vec2(e.x, 0.0)).r), hy = decH(texture(uAux, uv + vec2(0.0, e.y)).r);
  vec3 n = normalize(vec3((h0 - hx)/uMpt, (h0 - hy)/uMpt, 1.0));
  float v = uv.y;
  float mott = fbm(uv*vec2(60.0,120.0), 60.0, 3);
  float rustN = smoothstep(0.62, 0.90, fbm(uv*vec2(80.0,40.0), 80.0, 3)) * uRust;
  float st = stampM(uv);
  vec3 albedo; float rough, metal, ao = 1.0;
  if (inR(v, FZ) || inR(v, FS)){
    // оцинковка с жёлтым хроматом пятнами
    float chrom = smoothstep(0.35, 0.75, fbm(uv*vec2(10.0,20.0), 10.0, 3));
    albedo = mix(vec3(0.24, 0.25, 0.235), vec3(0.28, 0.26, 0.16), chrom*0.5) * (0.85 + 0.25*mott);
    rough = 0.60 + 0.12*mott - 0.12*uSmudge*smoothstep(0.5, 0.8, fbm(uv*vec2(20.0,40.0), 20.0, 3));
    metal = 1.0;
    if (v >= THR.x && v <= THR.y){ albedo *= 0.55; rough = 0.34; }
    if (inR(v, FZ)) ao = 1.0 - 0.45*(1.0 - smoothstep(FZ.x, THR.y + 0.02, v));
    if (inR(v, FS)) ao = 0.85;
    albedo = mix(albedo, albedo*0.35, st);
    rough = mix(rough, 0.7, st);
    ao *= 1.0 - 0.6*st;
  } else if (v < LO.x - 0.01){
    // стальная проволока: чека, кольцо, клип
    float tarn = smoothstep(0.4, 0.8, fbm(uv*vec2(20.0,4.0), 20.0, 3));
    vec3 base = inR(v, CL) ? vec3(0.44, 0.44, 0.45) : vec3(0.60, 0.60, 0.61);
    albedo = base * (0.86 + 0.22*mott) * mix(1.0, 0.78, tarn*0.5);
    rough = (inR(v, CL) ? 0.36 : 0.26) + 0.12*tarn + 0.05*mott;
    metal = 1.0;
  } else {
    // рычаг: зелёная краска, стёртая по кромкам, выбитая маркировка
    vec2 r = inR(v, LO) ? LO : (inR(v, LI) ? LI : LE);
    float a = clamp((v - r.x) / (r.y - r.x), 0.0, 1.0);
    float edge = inR(v, LE) ? 0.7 : smoothstep(0.14, 0.0, min(a, 1.0 - a));
    edge = max(edge, smoothstep(0.05, 0.0, uv.x - 0.01) + smoothstep(0.96, 0.99, uv.x));
    float n1 = fbm(uv*vec2(150.0,150.0), 0.0, 4);
    float t = 0.84 - 0.30*uWear*(0.05 + 0.95*edge);
    float bare = smoothstep(t, t + 0.03, n1);
    float scr = inR(v, LO) ? scratch(uv, 420.0, 40.0) * (0.3 + 0.7*uWear) : 0.0;
    bare = clamp(bare + scr*0.5, 0.0, 1.0);
    vec3 paint = OLIVE * 1.05 * (0.86 + 0.28*mott);
    vec3 steel = vec3(0.40, 0.40, 0.41) * (0.8 + 0.3*mott);
    albedo = mix(paint, steel, bare);
    rough = mix(0.58 - 0.06*mott, 0.34, bare);
    metal = bare;
    albedo = mix(albedo, albedo*0.45, st);
    ao = (inR(v, LI) ? 0.62 : 1.0) * (1.0 - 0.45*st);
  }
  albedo = mix(albedo, RUSTC * (0.8 + 0.4*mott), rustN*0.5);
  rough = mix(rough, 0.88, rustN*0.5);
  metal = mix(metal, 0.0, rustN*0.5);
  oAlb = vec4(clamp(albedo, 0.0, 1.0), 1.0);
  oNrm = vec4(n * 0.5 + 0.5, 1.0);
  oOrm = vec4(clamp(ao, 0.0, 1.0), clamp(rough, 0.04, 1.0), clamp(metal, 0.0, 1.0), 1.0);
}
#endif
`;
}

function makeMRT(w, h, wrapS, aniso) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    count: 3, depthBuffer: false, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    wrapS, wrapT: THREE.ClampToEdgeWrapping, type: THREE.UnsignedByteType,
  });
  // albedo хранится в SRGB8_ALPHA8: шейдер пишет линейный цвет, кодирует железо
  rt.textures[0].colorSpace = THREE.SRGBColorSpace;
  rt.textures[1].colorSpace = THREE.NoColorSpace;
  rt.textures[2].colorSpace = THREE.NoColorSpace;
  for (const t of rt.textures) t.anisotropy = aniso;
  rt.textures[0].name = 'albedo'; rt.textures[1].name = 'normal'; rt.textures[2].name = 'orm';
  return rt;
}

// ---------------------------------------------------------------- сборка

export async function buildM67(opts = {}) {
  const renderer = opts.renderer;
  const q = QI[opts.quality] ?? 1;
  const params = { wear: opts.wear ?? 0.35, rust: opts.rust ?? 0.15, smudge: opts.smudge ?? 0.3, seed: opts.seed ?? 1 };
  const disposables = [];
  const own = (x) => { disposables.push(x); return x; };

  const group = new THREE.Group();
  group.name = 'M67';

  // --- геометрия
  const body = bodyGeometry(q);
  const fuze = fuzeGeometry(q);
  const curve = leverCurve();
  const lever = leverGeometry(q, curve);
  const pin = pinGeometry(q);
  const ring = ringGeometry(q);
  const clip = clipCurve(curve, lever.tPin);
  const clipGeom = remapUV(new THREE.TubeGeometry(clip.curve, [48, 80, 120][q], 0.00055, [5, 6, 8][q], true), [0.01, MV.CL[0], 0.99, MV.CL[1]]);
  clipGeom.translate(-clip.pivot.x, -clip.pivot.y, -clip.pivot.z);
  for (const g of [body.geom, fuze.geom, lever.geom, pin.legs, pin.tip, ring.geom, clipGeom]) own(g);

  // --- надписи и запечка
  const leverLen = curve.getLength();
  const s5 = FUZE_STRIPS[4];
  let s5len = 0;
  for (let i = 1; i < s5.length; i++) s5len += Math.hypot(s5[i][0] - s5[i - 1][0], s5[i][1] - s5[i - 1][1]);
  const vAtY = (y) => {  // v на цилиндрической части запала (первый отрезок полосы 5)
    const r = fuze.ranges[4], y0 = s5[0][1], y1 = s5[1][1];
    return lerp(r[0], r[0] + (r[1] - r[0]) * (y1 - y0) / s5len, (y - y0) / (y1 - y0));
  };
  const mainV = [vAtY(s5[0][1]), vAtY(s5[1][1])];
  const fz = { leverLen, tStamp: 0.72, mainV, mainLen: s5[1][1] - s5[0][1], ventV: vAtY(0.0500), threadV: fuze.ranges[0] };
  const rnd = rng(0x6d67 ^ params.seed);
  const bodyW = [512, 1024, 2048][q], metalS = [512, 1024, 1024][q];
  const decalBody = own(new THREE.CanvasTexture(makeBodyDecal(Math.max(1024, bodyW), body.vHole, rnd)));
  const decalMetal = own(new THREE.CanvasTexture(makeMetalDecal(1024, fz, rnd)));
  for (const t of [decalBody, decalMetal]) { t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4; }
  decalBody.wrapS = THREE.RepeatWrapping;

  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const rtBody = own(makeMRT(bodyW, bodyW / 2, THREE.RepeatWrapping, aniso));
  const rtMetal = own(makeMRT(metalS, metalS, THREE.RepeatWrapping, aniso));

  const mkBake = (fs, decal, w, h, extra = {}) => {
    const uniforms = {
      uDecal: { value: decal }, uRes: { value: new THREE.Vector2(w, h) }, uAux: { value: null },
      uWear: { value: 0 }, uRust: { value: 0 }, uSmudge: { value: 0 }, uSeed: { value: 0 }, ...extra,
    };
    const mk = (defines) => own(new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: BAKE_VS, fragmentShader: fs, depthTest: false, depthWrite: false, defines, uniforms,
    }));
    return { aux: mk({ AUX: '' }), main: mk({}), uniforms, w, h };
  };
  const bakes = [
    { ...mkBake(bodyFS(body.vHole), decalBody, bodyW, bodyW / 2), rt: rtBody, wrap: THREE.RepeatWrapping },
    { ...mkBake(metalFS(fz), decalMetal, metalS, metalS, { uMpt: { value: 0.12 / metalS } }), rt: rtMetal, wrap: THREE.RepeatWrapping },
  ];
  const auxType = renderer.extensions.has('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const quadGeom = own(new THREE.PlaneGeometry(2, 2));
  const quad = new THREE.Mesh(quadGeom, bakes[0].main);
  quad.frustumCulled = false;
  const bakeScene = new THREE.Scene();
  bakeScene.add(quad);
  const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Два прохода: высота+сколы во временную цель, затем карты (нормаль по соседним текселям высоты).
  function bake() {
    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    for (const b of bakes) {
      const u = b.uniforms;
      u.uWear.value = params.wear; u.uRust.value = params.rust; u.uSmudge.value = params.smudge; u.uSeed.value = (params.seed % 97) * 0.37;
      const aux = new THREE.WebGLRenderTarget(b.w, b.h, {
        depthBuffer: false, type: auxType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, wrapS: b.wrap,
      });
      quad.material = b.aux;
      renderer.setRenderTarget(aux);
      renderer.render(bakeScene, bakeCam);
      u.uAux.value = aux.texture;
      quad.material = b.main;
      renderer.setRenderTarget(b.rt);
      renderer.render(bakeScene, bakeCam);  // мипы генерирует сам render() для текущей цели
      u.uAux.value = null;
      aux.dispose();
    }
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;
  }
  bake();

  const orm = rtBody.textures[2], ormM = rtMetal.textures[2];
  const bodyMat = own(new THREE.MeshStandardMaterial({
    name: 'M67.body', map: rtBody.textures[0], normalMap: rtBody.textures[1],
    roughnessMap: orm, metalnessMap: orm, aoMap: orm, roughness: 1, metalness: 1,
  }));
  const metalOpts = {
    map: rtMetal.textures[0], normalMap: rtMetal.textures[1],
    roughnessMap: ormM, metalnessMap: ormM, aoMap: ormM, roughness: 1, metalness: 1,
  };
  const metalMat = own(new THREE.MeshStandardMaterial({ name: 'M67.metal', ...metalOpts }));
  // Плоскость разреза всегда подключена (без перекомпиляции при переключении); выключено = отодвинута.
  const cutLocal = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  const cutWorld = new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e6);
  const fuzeMat = own(new THREE.MeshStandardMaterial({ name: 'M67.fuze', ...metalOpts, side: THREE.DoubleSide, clippingPlanes: [cutWorld] }));

  const mesh = (g, m, name) => {
    const x = new THREE.Mesh(g, m);
    x.name = name; x.castShadow = true; x.receiveShadow = true;
    return x;
  };
  const pivot = (name, p) => { const o = new THREE.Group(); o.name = name; o.position.copy(p); return o; };

  // корпус
  const pBody = pivot('body', new THREE.Vector3());
  const bodyMesh = mesh(body.geom, bodyMat, 'M67.bodyMesh');
  pBody.add(bodyMesh);

  // запал
  const fuzeBase = new THREE.Vector3(0, FUZE_BASE_Y, 0);
  fuze.geom.translate(0, -FUZE_BASE_Y, 0);
  const pFuze = pivot('fuze', fuzeBase);
  const fuzeMesh = mesh(fuze.geom, fuzeMat, 'M67.fuzeMesh');
  let cutOn = false;
  // плоскость x = 0 в локали запала (пивот запала лежит на оси)
  fuzeMesh.onBeforeRender = () => { if (cutOn) cutWorld.copy(cutLocal).applyMatrix4(fuzeMesh.matrixWorld); };
  pFuze.add(fuzeMesh);

  // разрез: крышка сечения + капсюль, замедлитель (выгоревший / фронт / целый), детонатор
  const capGeom = own(sectionCapGeometry().translate(0, -FUZE_BASE_Y, 0));
  const capMat = own(new THREE.MeshStandardMaterial({ name: 'M67.section', color: 0xb9bcc0, metalness: 0.85, roughness: 0.32 }));
  const cutGroup = new THREE.Group();
  cutGroup.name = 'cutaway';
  cutGroup.visible = false;
  cutGroup.add(mesh(capGeom, capMat, 'section'));
  const cyl = own(new THREE.CylinderGeometry(1, 1, 1, 20, 1));
  const inner = (name, color, r, y0, y1, extra = {}) => {
    const m = mesh(cyl, own(new THREE.MeshStandardMaterial({ name, color, ...extra })), name);
    m.scale.set(r, y1 - y0, r); m.position.y = (y0 + y1) / 2 - FUZE_BASE_Y;
    cutGroup.add(m);
    return m;
  };
  const DEL0 = 0.0395, DEL1 = 0.0508, DEL_R = 0.0021;
  inner('primer', 0xb08a3c, 0.0025, 0.0508, 0.0524, { metalness: 1, roughness: 0.35 });
  inner('detonator', 0xa6aab0, 0.0028, 0.0300, DEL0, { metalness: 1, roughness: 0.4 });
  const ash = inner('delay.ash', 0x151311, DEL_R, DEL1 - 0.001, DEL1, { roughness: 0.95 });
  const front = inner('delay.front', 0x2a0e02, DEL_R * 1.02, DEL1 - 0.0007, DEL1, { roughness: 0.6, emissive: 0xff6a12, emissiveIntensity: 6 });
  const fresh = inner('delay.fresh', 0x6d6a63, DEL_R, DEL0, DEL1, { roughness: 0.85 });
  front.castShadow = false;
  const span = (o, y0, y1) => { o.visible = y1 - y0 > 1e-6; o.scale.y = Math.max(1e-6, y1 - y0); o.position.y = (y0 + y1) / 2 - FUZE_BASE_Y; };
  pFuze.add(cutGroup);

  // рычаг
  const pLever = pivot('lever', HINGE);
  pLever.add(mesh(lever.geom, metalMat, 'M67.leverMesh'));

  // чека + кольцо
  const pPin = pivot('pin', PIN_C);
  pPin.add(mesh(pin.legs, metalMat, 'M67.pinMesh'));
  const tipA = mesh(pin.tip, metalMat, 'pinTipA'), tipB = mesh(pin.tip, metalMat, 'pinTipB');
  tipA.position.set(0, LEG_R, PIN_Z0); tipB.position.set(0, -LEG_R, PIN_Z0);
  pPin.add(tipA, tipB);
  const TIP_ANG = 0.62;
  const pRing = pivot('ring', new THREE.Vector3(0, 0, EYE_Z));
  pRing.add(mesh(ring.geom, metalMat, 'M67.ringMesh'));
  pPin.add(pRing);

  // клип
  const pClip = pivot('clip', clip.pivot);
  pClip.add(mesh(clipGeom, metalMat, 'M67.clipMesh'));

  group.add(pBody, pFuze, pLever, pPin, pClip);
  const parts = { body: pBody, fuze: pFuze, lever: pLever, pin: pPin, ring: pRing, clip: pClip };
  const initial = Object.values(parts).map((o) => ({ o, parent: o.parent, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
  const clipInit = initial.find((x) => x.o === pClip);

  // --- интерфейс
  const axis = new THREE.Vector3(0, 0, 1);
  const pinApi = {
    axis, travel: PIN_TRAVEL, d: 0,
    colliders: [
      { p: new THREE.Vector3(0, 0, -0.005), r: 0.0012 }, { p: new THREE.Vector3(0, 0, 0.006), r: 0.0012 },
      { p: ring.center.clone().add(pRing.position), r: 0.0030 },
      ...[0, 2.1, 4.2].map((a) => ({ p: ring.center.clone().add(pRing.position).addScaledVector(new THREE.Vector3(0, -Math.sin(RING_TILT), Math.cos(RING_TILT)), RING_RM * Math.cos(a)).add(new THREE.Vector3(RING_RM * Math.sin(a), 0, 0)), r: 0.0018 })),
    ],
    set(d) {
      d = Math.min(PIN_TRAVEL, Math.max(0, d));
      pinApi.d = d;
      pPin.position.copy(PIN_C).addScaledVector(axis, d);
      const k = 1 - Math.min(1, d / (0.15 * PIN_TRAVEL));  // усики разгибаются на первых 15% хода
      tipA.rotation.x = TIP_ANG * k; tipB.rotation.x = -TIP_ANG * k;
    },
  };
  pinApi.set(0);

  const leverCols = [0.12, 0.32, 0.52, 0.72, 0.93].map((t) => ({
    p: curve.getPointAt(t).sub(HINGE), r: t < 0.4 ? 0.0060 : lerp(0.0060, 0.0048, (t - 0.4) / 0.6),
  }));
  const clipCols = [0, 0.2, 0.5, 0.8].map((t) => ({ p: clip.curve.getPointAt(t).sub(clip.pivot), r: 0.0026 }));

  const box = new THREE.Box3();
  group.updateMatrixWorld(true);
  box.setFromObject(group, true);
  const fuzeTop = box.max.y;

  const m = {
    group, parts, bodyMesh, pin: pinApi,
    lever: { hinge: HINGE.clone(), axis: new THREE.Vector3(0, 0, 1), colliders: leverCols },
    ring: { colliders: pinApi.colliders.slice(2).map((c) => ({ p: c.p.clone().sub(pRing.position), r: c.r })) },
    clip: {
      colliders: clipCols, on: true,
      set(on) {
        m.clip.on = !!on;
        pClip.visible = !!on;
        if (on) { const s = clipInit; s.parent.add(pClip); pClip.position.copy(s.p); pClip.quaternion.copy(s.q); }
      },
    },
    fuzeVent: new THREE.Vector3(0, 0.0500, 0.0096),
    cutaway: {
      on: false,
      set(on) {
        cutOn = !!on; m.cutaway.on = cutOn; cutGroup.visible = cutOn;
        if (!cutOn) cutWorld.set(cutLocal.normal, 1e6);
      },
      burn(f) {
        f = Math.min(1, Math.max(0, f));
        const yf = DEL1 - f * (DEL1 - DEL0), fh = 0.0006;
        span(ash, yf, DEL1);
        span(fresh, DEL0, Math.max(DEL0, yf - fh));
        span(front, Math.max(DEL0, yf - fh), Math.min(DEL1, yf + fh * 0.2));
        front.visible = f > 0 && f < 1;
      },
    },
    maps: {
      map: rtBody.textures[0], normalMap: rtBody.textures[1], ormMap: orm, roughnessMap: orm, metalnessMap: orm, aoMap: orm,
      metal: { map: rtMetal.textures[0], normalMap: rtMetal.textures[1], ormMap: ormM },
    },
    materials: { body: bodyMat, metal: metalMat, fuze: fuzeMat },
    dims: { R, height: fuzeTop + R, fuzeTop, mass: 0.40 },
    rebake(o = {}) {
      if (o.wear !== undefined) params.wear = o.wear;
      if (o.rust !== undefined) params.rust = o.rust;
      if (o.smudge !== undefined) params.smudge = o.smudge;
      if (o.seed !== undefined) params.seed = o.seed;
      bake();
    },
    // Вернуть все детали на место (после броска/разлёта).
    reset() {
      for (const s of initial) { s.parent.add(s.o); s.o.position.copy(s.p); s.o.quaternion.copy(s.q); s.o.scale.copy(s.s); s.o.visible = true; }
      pinApi.set(0); m.clip.on = true;
    },
    dispose() {
      group.removeFromParent();
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    },
  };
  m.cutaway.burn(0);
  return m;
}
