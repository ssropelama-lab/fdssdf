import * as THREE from 'three';
import { startApp } from '../core/app.js';
import { buildM67 } from './model.js';
import { M67Blast } from './blast.js';
import { inertia } from '../core/physics.js';
import { logInterp } from '../core/rng.js';

// Приводим модель к общему интерфейсу ядра
async function adaptM67({ renderer, quality }) {
  const m = await buildM67({ renderer, quality, wear: 0.55, rust: 0.35, smudge: 0.5 });
  const P = m.parts;
  const R = m.dims.R;
  const leverBase = P.lever.rotation.z;
  const mass = m.dims.mass;
  return {
    group: m.group,
    bodyMesh: m.bodyMesh,
    dims: m.dims,
    body: {
      mass, restY: R + 0.004,
      colliders: [{ p: new THREE.Vector3(0, 0, 0), r: R }, { p: new THREE.Vector3(0, 0.046, 0), r: 0.011 }],
      inertia: inertia.sphere(mass, R),
      restitution: 0.25, rolling: 0.012,
    },
    pin: {
      obj: P.pin, ringObj: P.ring, ringCenter: m.ring.colliders[0].p.clone(),
      anchor: P.pin.position.clone(), axis: m.pin.axis.clone(), travel: m.pin.travel,
      set: (d) => m.pin.set(d),
      colliders: m.pin.colliders, mass: 0.01,
    },
    lever: {
      obj: P.lever, hinge: m.lever.hinge, axis: m.lever.axis, kick: 95,
      set(a) { P.lever.rotation.z = leverBase + a; },
      colliders: m.lever.colliders, mass: 0.02,
    },
    // clip.set(false) в модели прячет клип — при снятии он становится телом, поэтому только «вернуть»
    clip: { obj: P.clip, set(on) { if (on) m.clip.set(true); }, colliders: m.clip.colliders, mass: 0.004, grabCenter: m.clip.colliders[1].p.clone() },
    fuzeVent: m.fuzeVent,
    cutaway: m.cutaway,
    reset() { m.reset(); P.lever.rotation.z = leverBase; m.cutaway.burn(0); },
  };
}

// Скоростная камера: переменная скорость (≈2,4 млн → 10 тыс. → 1 тыс. к/с → реальное время)
const SLOW = [[1e-7, 40000], [3.5e-5, 40000], [2e-4, 3000], [5e-3, 170], [8e-2, 17], [1.5, 1]];
// камера начинает вплотную к корпусу и отъезжает вслед за огненным шаром и дымом
const DIST = [[1e-7, 0.3], [3e-5, 0.32], [4e-4, 0.7], [0.02, 1.6], [0.6, 2.6]];
const fmtT = (t) => (t < 1e-3 ? `t = ${(t * 1e6).toFixed(1)} мкс` : t < 1 ? `t = ${(t * 1000).toFixed(2)} мс` : `t = ${t.toFixed(2)} с`);

startApp({
  id: 'm67',
  title: 'M67 · осколочная граната',
  subtitle: 'гладкая сфера Ø63,5 мм · запал M213 · задержка 4–5,5 с · 400 г',
  hint: 'ЛКМ — действия и бросок · колесо — зум · Space — следующее действие · R — сброс',
  hasClip: true,
  fuse: [4.0, 5.5],
  restYaw: 0,
  homeDist: 0.3,
  wideDist: 5.5,
  throwSpin: 14,
  options: [{ type: 'switch', key: 'cutaway', label: 'Разрез запала', value: false }],
  buildModel: adaptM67,
  createBlast: (app) => new M67Blast(app),
  replay: {
    dist: 1.5, height: 0.3,
    slowdown: (t) => logInterp(SLOW, t),
    distAt: (t) => logInterp(DIST, t),
    label: fmtT,
    fpsLabel: (s) => `≈ ${Math.round(60 * s).toLocaleString('ru-RU')} к/с`,
  },
});
