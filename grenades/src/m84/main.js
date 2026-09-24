import * as THREE from 'three';
import { startApp } from '../core/app.js';
import { buildFlashbang } from './model.js';
import { M84Blast } from './blast.js';
import { inertia } from '../core/physics.js';
import { smooth, logInterp } from '../core/rng.js';

const mm = (x) => x / 1000;
const V = (x, y, z) => new THREE.Vector3(mm(x), mm(y), mm(z));

// Приводим модель к общему интерфейсу ядра
function adaptM84() {
  const g = buildFlashbang();
  const P = g.parts;
  const pinBaseZ = P.pin.position.z;
  const leverBase = P.spoon.rotation.z;
  const strikerBaseY = P.striker.position.y;
  const mass = 0.236;
  return {
    group: g,
    ports: g.ports,
    setGlow: g.setGlow,
    body: {
      mass, restY: g.userData.dims.H + 0.004,
      colliders: [-44, -22, 0, 22, 44].map((y) => ({ p: V(0, y, 0), r: mm(22.5) })).concat([{ p: V(0, 84, 0), r: mm(11) }, { p: V(14, 70, 0), r: mm(8) }]),
      inertia: inertia.cylinderY(mass, mm(22.5), mm(133)),
      restitution: 0.25, rolling: 0.03,
    },
    pin: {
      obj: P.pin, ringObj: P.ring, ringCenter: V(0, 0, 12.5),
      anchor: V(12, 86, 2), axis: new THREE.Vector3(0, 0, 1), travel: mm(26),
      set(d) { P.pin.position.z = pinBaseZ + d; },
      colliders: [{ p: V(12, 0, 0), r: mm(3) }, { p: V(12, 0, 31), r: mm(11) }], mass: 0.012,
    },
    lever: {
      obj: P.spoon, hinge: V(12, 93, 0), axis: new THREE.Vector3(0, 0, 1), kick: 90,
      set(a) { P.spoon.rotation.z = leverBase + a; },
      colliders: [{ p: V(-6, 7, 0), r: mm(4) }, { p: V(11.5, -8, 0), r: mm(4) }, { p: V(11.5, -40, 0), r: mm(4) }, { p: V(10, -74, 0), r: mm(4) }], mass: 0.016,
    },
    clip: null,
    fuzeVent: V(0, 99, 0),
    striker(on) { P.striker.position.y = strikerBaseY - (on ? mm(2.5) : 0); },
    reset() { P.striker.position.y = strikerBaseY; g.setGlow(0); },
  };
}

const lg = Math.log;
startApp({
  id: 'm84',
  title: 'M84 · светошумовая граната',
  subtitle: 'замедлитель 1–2,3 с · ~7 млн кд · 170–180 дБ · корпус не разрушается',
  hint: 'ЛКМ — действия и бросок · колесо — зум · Space — следующее действие · R — сброс',
  hasClip: false,
  fuse: [1.0, 2.3],
  restYaw: -0.5,
  homeDist: 0.55,
  wideDist: 3.2,
  throwSpin: 10,
  buildModel: async () => adaptM84(),
  createBlast: (app) => new M84Blast(app),
  replay: {
    dist: 1.2, height: 0.35,
    // 0–30 мс: ×60, к 0,4 с: ×8, к 2,5 с — реальное время
    slowdown: (t) => Math.exp(lg(60) + (lg(8) - lg(60)) * smooth(0.03, 0.4, t) - lg(8) * smooth(0.4, 2.5, t)),
    distAt: (t) => logInterp([[1e-4, 0.7], [0.05, 1.1], [1.5, 2.2]], t),
    label: (t) => (t < 1 ? `t = ${(t * 1000).toFixed(1)} мс` : `t = ${t.toFixed(2)} с`),
    fpsLabel: (s) => `≈ ${Math.round(60 * s).toLocaleString('ru-RU')} к/с`,
  },
});
