// Модель M84 перенесена из прежнего flashbang_m84.html без изменений геометрии.
import * as THREE from 'three';

/* ============================================================================
   МОДЕЛЬ M84 — единственное качество (бывший LOD0, сегментация поднята).
   ЕДИНИЦЫ: метры, mm(x) = x/1000. Цифры в комментариях — реальные миллиметры.
   ОСИ: +Y вверх (запал сверху), +X — сторона скобы.
   ORIGIN: геометрический центр стального корпуса.
============================================================================ */
export function buildFlashbang(opts = {}) {
  const mm = (x) => x / 1000;
  const TAU = Math.PI * 2;

  const o = Object.assign({ holes: true, wear: true }, opts);

  // Максимальное качество: LOD-ветки убраны, сегментация повышена.
  const SEG_BODY  = 48;  // радиальных сегментов на корпус
  const SEG_SMALL = 24;  // запал, ударник
  const SEG_TUBE  = 10;  // сечение прутка чеки и кольца
  const SEG_RING  = 32;  // кольцо по окружности
  const HOLE_SUB  = 6;   // подпоясов на отверстие (круглость окна)
  const HOLES_ON  = !!o.holes;
  const WEAR_ON   = !!o.wear;

  const group = new THREE.Group();
  group.name = 'M84_Flashbang';

  /* ============ МАТЕРИАЛЫ ============ */
  const steelDark = new THREE.MeshStandardMaterial({ name: 'steelDark', color: 0x35383c, metalness: 0.70, roughness: 0.52 });
  const chargeMat = new THREE.MeshStandardMaterial({ name: 'charge',    color: 0x141517, metalness: 0.15, roughness: 0.90 });
  const steel     = new THREE.MeshStandardMaterial({ name: 'steel',     color: 0x6a6d72, metalness: 0.85, roughness: 0.32 });
  const wearMat   = new THREE.MeshStandardMaterial({ name: 'wear',      color: 0x8f949b, metalness: 0.94, roughness: 0.20 });
  const materials = [steelDark, chargeMat, steel, wearMat];

  /* ============ УТИЛИТЫ ============ */
  function flipGeo(g) {
    const idx = g.index;
    if (idx) { const a = idx.array; for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; } idx.needsUpdate = true; }
    const n = g.attributes.normal;
    if (n) { const a = n.array; for (let i = 0; i < a.length; i++) a[i] = -a[i]; n.needsUpdate = true; }
    return g;
  }

  function mergeGeos(list) {
    list = list.filter(Boolean);
    if (list.length === 1) return list[0];
    let verts = 0, inds = 0;
    for (const g of list) {
      verts += g.attributes.position.count;
      inds  += g.index ? g.index.count : g.attributes.position.count;
    }
    const pos = new Float32Array(verts * 3);
    const nrm = new Float32Array(verts * 3);
    const idx = new Uint32Array(inds);
    let vo = 0, io = 0;
    for (const g of list) {
      pos.set(g.attributes.position.array, vo * 3);
      if (g.attributes.normal) nrm.set(g.attributes.normal.array, vo * 3);
      if (g.index) {
        const gi = g.index.array;
        for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
        io += gi.length;
      } else {
        const c = g.attributes.position.count;
        for (let i = 0; i < c; i++) idx[io + i] = i + vo;
        io += c;
      }
      vo += g.attributes.position.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    return out;
  }

  const lathe = (pts, seg) => new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), seg);
  const at = (g, x, y, z, rz) => { if (rz) g.rotateZ(rz); g.translate(x || 0, y || 0, z || 0); return g; };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

  /* ============ ГЕОМЕТРИЯ КОРПУСА ============ */
  const R_OUT    = mm(22.5);   // наружный радиус Ø45
  const R_IN     = mm(20.5);   // внутренний радиус, стенка 2.0
  const H_BODY   = mm(133);    // высота корпуса
  const HY       = H_BODY / 2; // 66.5
  const R_FILLET = mm(4);      // скругление торцов
  const HOLE_R   = mm(4);      // отверстие Ø8
  const N_HOLES  = 6;          // на пояс
  const BELT_HI  = mm(33.25);  // верхний пояс отверстий
  const BELT_LO  = mm(-33.25); // нижний пояс отверстий
  const FY       = HY;         // уровень посадки запала

  const dys = [];
  for (let k = 0; k <= HOLE_SUB; k++) dys.push(-HOLE_R + (2 * HOLE_R * k) / HOLE_SUB);
  const halfAngs = [];
  for (let k = 0; k < HOLE_SUB; k++) {
    const mid = (dys[k] + dys[k + 1]) / 2;
    const w = Math.sqrt(Math.max(0, HOLE_R * HOLE_R - mid * mid));
    halfAngs.push(Math.asin(Math.min(0.985, w / R_OUT)));
  }

  function sideWall(a, y0, y1, flip) {
    const s = Math.sin(a), c = Math.cos(a);
    const p = new Float32Array([
      R_IN * s,  y0, R_IN * c,
      R_OUT * s, y0, R_OUT * c,
      R_OUT * s, y1, R_OUT * c,
      R_IN * s,  y1, R_IN * c,
    ]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setIndex(flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    return g;
  }

  function ledge(center, y, from, to, up) {
    const a0 = Math.min(from, to), len = Math.abs(to - from);
    if (len < 1e-5) return null;
    const seg = Math.max(2, Math.min(8, Math.round(len / 0.04)));
    const g = new THREE.RingGeometry(R_IN, R_OUT, seg, 1, a0, len);
    g.rotateX(-Math.PI / 2);
    g.rotateY(center - Math.PI / 2);
    g.translate(0, y, 0);
    if (!up) flipGeo(g);
    return g;
  }

  function solidBand(y0, y1) {
    if (y1 - y0 < 1e-6) return null;
    const g = new THREE.CylinderGeometry(R_OUT, R_OUT, y1 - y0, SEG_BODY, 1, true);
    g.translate(0, (y0 + y1) / 2, 0);
    return g;
  }

  function holeBelt(beltY, out) {
    const step = TAU / N_HOLES;
    for (let k = 0; k < HOLE_SUB; k++) {
      const y0 = beltY + dys[k], y1 = beltY + dys[k + 1];
      const ha = halfAngs[k];
      const span = step - 2 * ha;
      const segs = Math.max(3, Math.round((SEG_BODY * span) / TAU));
      for (let i = 0; i < N_HOLES; i++) {
        const c = i * step;
        const a0 = c + ha, a1 = c + step - ha;
        const arc = new THREE.CylinderGeometry(R_OUT, R_OUT, y1 - y0, segs, 1, true, a0, span);
        arc.translate(0, (y0 + y1) / 2, 0);
        out.push(arc);
        out.push(sideWall(a0, y0, y1, false));
        out.push(sideWall(a1, y0, y1, true));
      }
    }
    for (let i = 0; i < N_HOLES; i++) {
      const c = i * step;
      for (let k = 0; k <= HOLE_SUB; k++) {
        const y = beltY + dys[k];
        const hp = k > 0 ? halfAngs[k - 1] : null;
        const hn = k < HOLE_SUB ? halfAngs[k] : null;
        if (hp === null) { out.push(ledge(c, y, -hn, hn, true)); continue; }
        if (hn === null) { out.push(ledge(c, y, -hp, hp, false)); continue; }
        if (Math.abs(hn - hp) < 1e-5) continue;
        const up = hn > hp;
        out.push(ledge(c, y, hp, hn, up));
        out.push(ledge(c, y, -hn, -hp, up));
      }
    }
  }

  const shell = [];
  if (HOLES_ON) {
    shell.push(solidBand(-HY + R_FILLET, BELT_LO - HOLE_R));
    holeBelt(BELT_LO, shell);
    shell.push(solidBand(BELT_LO + HOLE_R, BELT_HI - HOLE_R));
    holeBelt(BELT_HI, shell);
    shell.push(solidBand(BELT_HI + HOLE_R, HY - R_FILLET));
  } else {
    shell.push(solidBand(-HY + R_FILLET, HY - R_FILLET));
  }

  /* ---- Крышки с проточками ---- */
  const fMid = R_FILLET * Math.SQRT1_2;

  const topProfile = [
    [R_IN,             HY - mm(7)],
    [mm(11),           HY - mm(7)],
    [mm(11),           HY],
    [mm(15.5),         HY],
    [mm(15.5),         HY - mm(1.6)],
    [mm(18),           HY - mm(1.6)],
    [mm(18),           HY],
    [R_OUT - R_FILLET, HY],
    [R_OUT - R_FILLET + fMid, HY - R_FILLET + fMid],
    [R_OUT,            HY - R_FILLET],
    [R_OUT,            HY - mm(6)],
  ];

  const botProfile = [
    [R_OUT,            -HY + mm(6)],
    [R_OUT,            -HY + R_FILLET],
    [R_OUT - R_FILLET + fMid, -HY + R_FILLET - fMid],
    [R_OUT - R_FILLET, -HY],
    [mm(17),           -HY],
    [mm(17),           -HY + mm(1.6)],
    [mm(14),           -HY + mm(1.6)],
    [mm(14),           -HY],
    [0,                -HY],
  ];

  shell.push(lathe(topProfile, SEG_BODY));
  shell.push(lathe(botProfile, SEG_BODY));

  /* ---- Запал M201A1: корпус Ø22 × 28 + рифление + проушина ---- */
  const F_R = mm(11), F_H = mm(28);
  {
    const t = new THREE.CylinderGeometry(F_R, F_R, F_H, SEG_SMALL, 1, false);
    t.translate(0, FY + F_H / 2, 0);                 // y 66.5 → 94.5
    shell.push(t);

    const NR = 20;                                    // рифление под ключ
    for (let i = 0; i < NR; i++) {
      const a = (i / NR) * TAU;
      const r = box(mm(1.5), mm(14), mm(2.2));
      r.translate(0, 0, F_R - mm(0.4));
      r.rotateY(a);
      r.translate(0, FY + mm(11), 0);
      shell.push(r);
    }

    // Проушина: ось скобы (y 93) и отверстие под чеку (y 86)
    shell.push(at(box(mm(4.5), mm(20), mm(18)), mm(12), mm(89.5), 0));
  }

  const bodyGeo = mergeGeos(shell);
  bodyGeo.computeBoundingBox();
  const bodyMesh = new THREE.Mesh(bodyGeo, steelDark);
  bodyMesh.name = 'body_shell';
  bodyMesh.castShadow = bodyMesh.receiveShadow = true;

  /* ---- Пиротехнический заряд Ø34 + тёмная полость Ø40.2 ---- */
  const chargeParts = [new THREE.CylinderGeometry(mm(17), mm(17), mm(112), SEG_BODY, 1, false)];
  if (HOLES_ON) {
    const cav = new THREE.CylinderGeometry(R_IN - mm(0.4), R_IN - mm(0.4), mm(119), SEG_BODY, 1, true);
    chargeParts.push(flipGeo(cav));
  }
  const chargeGeo = mergeGeos(chargeParts);
  const chargeMesh = new THREE.Mesh(chargeGeo, chargeMat);
  chargeMesh.name = 'charge_core';
  chargeMesh.castShadow = false;      // не перекрывает свет вспышки изнутри
  chargeMesh.receiveShadow = true;

  /* ---- Потёртости по кромкам ---- */
  let wearMesh = null;
  if (WEAR_ON) {
    const K = 1.006;
    const arc = (sign) => {
      const pts = [];
      for (let i = 0; i <= 3; i++) {
        const t = (i / 3) * (Math.PI / 2);
        pts.push([
          (R_OUT - R_FILLET) + Math.sin(t) * R_FILLET * K,
          sign * ((HY - R_FILLET) + Math.cos(t) * R_FILLET * K),
        ]);
      }
      return lathe(pts, SEG_BODY);
    };
    const wg = mergeGeos([arc(1), arc(-1)]);
    wearMesh = new THREE.Mesh(wg, wearMat);
    wearMesh.name = 'body_wear';
    wearMesh.castShadow = wearMesh.receiveShadow = true;
  }

  /* ---- Ударник: отдельная деталь, чтобы срабатывал при сходе скобы ---- */
  const strikerGroup = new THREE.Group();
  strikerGroup.name = 'striker_group';
  strikerGroup.position.set(0, FY + F_H + mm(2), 0);   // y 96.5
  {
    const p = [];
    p.push(new THREE.CylinderGeometry(mm(6.5), mm(6.5), mm(4), SEG_SMALL, 1, false));
    const stem = new THREE.CylinderGeometry(mm(2.6), mm(2.6), mm(7), SEG_SMALL, 1, false);
    stem.translate(0, -mm(5), 0);
    p.push(stem);
    const sm = new THREE.Mesh(mergeGeos(p), steel);
    sm.name = 'striker';
    sm.castShadow = sm.receiveShadow = true;
    strikerGroup.add(sm);
  }

  /* ---- Скоба (spoon): ось в (12, 93) ---- */
  const spoonPivot = new THREE.Group();
  spoonPivot.name = 'spoon_pivot';
  spoonPivot.position.set(mm(12), mm(93), 0);
  {
    const p = [];
    p.push(box(mm(7), mm(7), mm(18)));                                    // бобышка шарнира
    p.push(at(box(mm(22), mm(2.2), mm(16)), mm(-10), mm(7.5), 0));        // крюк над ударником
    p.push(at(box(mm(5), mm(9), mm(16)), mm(0.5), mm(4), 0));             // стойка к крюку
    p.push(at(box(mm(13), mm(2.4), mm(16)), mm(6), mm(2.5), 0));          // плечо к полотну
    p.push(at(box(mm(2.4), mm(80), mm(16)), mm(11.5), mm(-37), 0));       // полотно 80 мм
    p.push(at(box(mm(5), mm(70), mm(2.4)), mm(14.3), mm(-37), 0));        // ребро жёсткости
    p.push(at(box(mm(4), mm(74), mm(1.6)), mm(13.6), mm(-37), mm(7.2)));  // отбортовка +Z
    p.push(at(box(mm(4), mm(74), mm(1.6)), mm(13.6), mm(-37), mm(-7.2))); // отбортовка −Z
    p.push(at(box(mm(7), mm(2.4), mm(16)), mm(9.6), mm(-78.5), 0, -0.5)); // отогнутый носок
    const sm = new THREE.Mesh(mergeGeos(p), steel);
    sm.name = 'spoon_lever';
    sm.castShadow = sm.receiveShadow = true;
    spoonPivot.add(sm);
  }

  /* ---- Чека (pin): пруток Ø3 вдоль Z + два отогнутых усика ---- */
  const pinGroup = new THREE.Group();
  pinGroup.name = 'pin_group';
  pinGroup.position.set(0, mm(86), 0);
  {
    const p = [];
    const sh = new THREE.CylinderGeometry(mm(1.5), mm(1.5), mm(34), SEG_TUBE, 1, false);
    sh.rotateX(Math.PI / 2);
    sh.translate(mm(12), 0, mm(2));
    p.push(sh);
    const t1 = new THREE.CylinderGeometry(mm(1.3), mm(1.3), mm(11), SEG_TUBE, 1, false);
    t1.rotateZ(Math.PI / 2);
    t1.translate(mm(16.5), mm(1.6), mm(-14));
    p.push(t1);
    const t2 = new THREE.CylinderGeometry(mm(1.3), mm(1.3), mm(11), SEG_TUBE, 1, false);
    t2.rotateZ(Math.PI / 2);
    t2.translate(mm(16.5), mm(-1.6), mm(-14));
    p.push(t2);
    const pm = new THREE.Mesh(mergeGeos(p), steel);
    pm.name = 'pin_shaft';
    pm.castShadow = pm.receiveShadow = true;
    pinGroup.add(pm);
  }

  /* ---- Кольцо (ring) Ø25 на торце чеки ---- */
  const ringGroup = new THREE.Group();
  ringGroup.name = 'ring_group';
  ringGroup.position.set(mm(12), 0, mm(19));
  {
    const tg = new THREE.TorusGeometry(mm(12.5), mm(1.3), SEG_TUBE, SEG_RING);
    tg.rotateY(Math.PI / 2);
    tg.translate(0, 0, mm(12.5));
    const rm = new THREE.Mesh(tg, steel);
    rm.name = 'pull_ring';
    rm.castShadow = rm.receiveShadow = true;
    ringGroup.add(rm);
  }
  pinGroup.add(ringGroup);

  /* ============ СБОРКА ============ */
  const bodyGroup = new THREE.Group();
  bodyGroup.name = 'body_group';
  bodyGroup.add(bodyMesh, chargeMesh);
  if (wearMesh) bodyGroup.add(wearMesh);
  bodyGroup.add(strikerGroup, spoonPivot, pinGroup);
  group.add(bodyGroup);

  /* ============ ТОЧКИ ВЫХОДА СВЕТА И ГАЗОВ ============ */
  // Окна центрированы по углам i·60° (x = R·sin a, z = R·cos a).
  const ports = [];
  for (const beltY of [BELT_LO, BELT_HI]) {
    for (let i = 0; i < N_HOLES; i++) {
      const a = (i / N_HOLES) * TAU;
      ports.push({
        pos: new THREE.Vector3(R_OUT * Math.sin(a), beltY, R_OUT * Math.cos(a)),
        dir: new THREE.Vector3(Math.sin(a), 0, Math.cos(a)),
      });
    }
  }

  group.ports = ports;
  group.parts = { body: bodyGroup, spoon: spoonPivot, pin: pinGroup, ring: ringGroup, striker: strikerGroup };
  group.mats = { steelDark, chargeMat, steel, wearMat };
  group.userData.units = 'meters';
  group.userData.dims = { R: R_OUT, H: HY, fuseTop: mm(98.5), beltHi: BELT_HI, beltLo: BELT_LO };

  // Свечение снаряжения: видно сквозь окна корпуса.
  group.setGlow = (t) => {
    const k = Math.max(0, t);
    chargeMat.emissive.setRGB(1, 0.96 - 0.25 * Math.min(1, k * 0.35), 0.86 - 0.5 * Math.min(1, k * 0.5));
    chargeMat.emissiveIntensity = k;
  };
  group.setGlow(0);

  group.dispose = () => {
    group.traverse((c) => { if (c.isMesh && c.geometry) c.geometry.dispose(); });
    materials.forEach((m) => m.dispose());
  };

  return group;
}
