// Взрыв M84: корпус цел, его подбрасывает отдачей из отверстий и он кувыркается;
// из окон — короткие струи пламени, горящие частицы состава и плотный бело-серый дым.
// Ослепление: HDR-засветка до тонмаппинга по дистанции, взгляду и перекрытию (лучи),
// остаточное изображение из снимка кадра и постепенная адаптация глаза.
import * as THREE from 'three';
import { GpuParticles, PF } from '../core/particles.js';
import { World, Body, Track } from '../core/physics.js';
import { mulberry32, clamp, smooth } from '../core/rng.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3(), _e = new THREE.Euler(), _col = new THREE.Color();

// Ударная волна: сверхзвук у заряда → 343 м/с
export const shockRadius = (t, A = 0.45, tau = 0.0006) => 343 * t + A * (1 - Math.exp(-t / tau));

export class M84Blast {
  constructor(app) {
    this.app = app;
    this.center = new THREE.Vector3();
    this.detonated = false;
    this.duration = 14;
    this.track = new Track(6, 240);
    this.capQuatInv = new THREE.Quaternion();
    this.S = 0;
  }

  prepare() {
    const app = this.app, fx = app.post.fxUniforms;
    // Свет вспышки существует всегда (интенсивность 0) — иначе three.js пересоберёт шейдеры в кадре взрыва
    const L = this.light = new THREE.PointLight(0xfff6ea, 0, 14, 2);
    L.castShadow = true;
    L.shadow.mapSize.set(512, 512);
    L.shadow.camera.near = 0.02; L.shadow.camera.far = 12;
    L.shadow.bias = -0.002; L.shadow.normalBias = 0.002;
    L.shadow.autoUpdate = false;
    this.after = new THREE.PointLight(0xffa860, 0, 3, 2);
    app.scene.add(L, this.after);
    this.sparks = new GpuParticles({ capacity: 4096, kind: 'spark', fxUniforms: fx, name: 'm84Sparks' });
    this.jets = new GpuParticles({ capacity: 768, kind: 'glow', fxUniforms: fx, soft: 0.02, name: 'm84Jets' });
    app.fxScene.add(this.sparks.mesh, this.jets.mesh);
    // закопчённое пятно на полу
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    this.scorch = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshStandardMaterial({
      color: 0x0a0908, roughness: 1, alphaMap: tex, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    }));
    this.scorch.rotation.x = -Math.PI / 2;
    this.scorch.receiveShadow = true;
    app.scene.add(this.scorch);
    this.ports = app.model.ports;
  }

  setQuality() {}

  warm(on) {
    if (!on) { this.reset(); return; }
    const p = this.app.rig.position;
    this.light.intensity = 1; this.light.position.copy(p); this.light.shadow.needsUpdate = true;
    this.after.intensity = 1; this.after.position.copy(p);
    this.scorch.material.opacity = 0.01; this.scorch.position.set(p.x, 0.002, p.z);
    this.sparks.clear(); this.jets.clear();
    this.sparks.emit(p.x, p.y, p.z, 0, 0, 0, 0, 1e6, 0, 0, 0.01, 0.01, 1, 1, 1, 1);
    this.jets.emit(p.x, p.y, p.z, 0, 0, 0, 0, 1e6, 0, 0, 0.01, 0.01, 1, 1, 1, 1);
    this.sparks.commit(); this.jets.commit();
    this.sparks.time = this.jets.time = 1;
  }

  reset() {
    this.detonated = false;
    this.light.intensity = 0; this.after.intensity = 0;
    this.scorch.material.opacity = 0; this.scorch.visible = false;
    this.sparks.clear(); this.sparks.commit(); this.jets.clear(); this.jets.commit();
    this.app.model.setGlow && this.app.model.setGlow(0);
    this.S = 0; this.captured = false;
  }

  // Сила ослепления: дистанция × направление взгляда × видимость (5 лучей против укрытий)
  blindness(camera) {
    const c = this.center;
    const d = camera.position.distanceTo(c);
    camera.getWorldDirection(_fwd);
    _d.subVectors(c, camera.position).normalize();
    const facing = _fwd.dot(_d);
    const ray = this._ray || (this._ray = new THREE.Raycaster());
    const occ = this.app.stage.occluders;
    let vis = 0;
    const offs = [[0, 0, 0], [0.05, 0, 0], [-0.05, 0, 0], [0, 0.06, 0], [0, -0.03, 0.05]];
    for (const o of offs) {
      _v.set(c.x + o[0], c.y + o[1], c.z + o[2]);
      _v2.subVectors(_v, camera.position);
      const len = _v2.length(); _v2.multiplyScalar(1 / len);
      ray.set(camera.position, _v2); ray.far = len - 0.03;
      if (ray.intersectObjects(occ, false).length === 0) vis++;
    }
    vis /= offs.length;
    const fd = 1 / (1 + (d / 5) * (d / 5));
    const look = 0.3 + 0.7 * smooth(-0.3, 0.92, facing);
    // даже из-за укрытия зал заливает отражённым светом
    this.S = clamp(fd * (vis * look + (1 - vis) * 0.22), 0, 1);
    this.occlusion = 1 - vis;
    this.dist = d;
    return this.S;
  }

  detonate({ seed, pos, quat }) {
    const app = this.app, q = app.quality;
    this.reset();
    this.detonated = true;
    this.seed = seed;
    const rnd = mulberry32(seed ^ 0x84);
    this.center.copy(pos);
    this.startPos = pos.clone(); this.startQuat = quat.clone();
    // траектория корпуса после отдачи — считается один раз, дальше это функция времени
    const w = new World();
    w.planes = app.world.planes; w.boxes = app.world.boxes;
    const gb = app.gBody;
    const b = new Body({ colliders: gb.colliders, mass: gb.mass, inertia: new THREE.Vector3(1 / gb.invI.x, 1 / gb.invI.y, 1 / gb.invI.z), restitution: 0.35, friction: 0.5, rolling: 0.03 });
    b.pos.copy(pos); b.quat.copy(quat);
    const a = rnd() * Math.PI * 2;
    b.vel.set(Math.cos(a) * (0.4 + rnd() * 0.6), 0.9 + rnd() * 1.4, Math.sin(a) * (0.4 + rnd() * 0.6));
    b.ang.set((rnd() - 0.5) * 40, (rnd() - 0.5) * 20, (rnd() - 0.5) * 40);
    b.enabled = true;
    w.add(b);
    this.track.len = 0;
    this.track.push(b.pos, b.quat);
    for (let i = 0; i < this.track.n - 1; i++) { w.substep(1 / 240); this.track.push(b.pos, b.quat); }

    // струи и горящие частицы из 12 окон
    const sp = this.sparks, jt = this.jets;
    sp.clear(); jt.clear();
    const nSp = Math.round(760 * q.sparks);
    for (let i = 0; i < this.ports.length; i++) {
      const port = this.ports[i];
      _v.copy(port.pos).applyQuaternion(quat).add(pos);
      _d.copy(port.dir).applyQuaternion(quat);
      for (let k = 0; k < 22; k++) {
        const s = 16 + rnd() * 22;
        jt.emit(_v.x, _v.y, _v.z, _d.x * s + (rnd() - 0.5) * 5, _d.y * s + (rnd() - 0.5) * 5 + 1, _d.z * s + (rnd() - 0.5) * 5,
          rnd() * 0.012, 0.03 + rnd() * 0.05, 24, -2, 0.015, 0.08 + rnd() * 0.08, 9, 7.2, 5, 1, 0, rnd(), 0, 0.02);
      }
      for (let k = 0; k < nSp / this.ports.length; k++) {
        const s = 2.5 + rnd() * 9;
        const cone = 0.55;
        const vx = _d.x + (rnd() - 0.5) * cone * 2, vy = _d.y + (rnd() - 0.3) * cone * 2, vz = _d.z + (rnd() - 0.5) * cone * 2;
        const big = rnd() < 0.12;
        sp.emit(_v.x, _v.y, _v.z, vx * s, vy * s, vz * s, rnd() * 0.02, big ? 1.4 + rnd() * 1.2 : 0.35 + rnd() * 1.1,
          big ? 0.8 : 1.4 + rnd() * 1.4, 9.81, big ? 0.012 : 0.005 + rnd() * 0.003, big ? 0.006 : 0.002,
          big ? 6 : 9, big ? 4.2 : 6.5, big ? 2.2 : 3.8, 1, big ? 0.3 : 1, rnd(), PF.FLOOR, 0);
      }
    }
    sp.commit(); jt.commit();

    // дым: 12 струй из окон + общее облако
    const puffs = [];
    for (let i = 0; i < this.ports.length && puffs.length < 12; i++) {
      const port = this.ports[i];
      _v.copy(port.pos).applyQuaternion(quat).add(pos);
      _d.copy(port.dir).applyQuaternion(quat);
      puffs.push({ x: _v.x, y: _v.y, z: _v.z, vx: _d.x * 2.2, vy: _d.y * 2.2 + 0.25, vz: _d.z * 2.2, k: 3.2, rise: 0.05, r0: 0.03, r1: 0.26 + rnd() * 0.12, tau: 0.45, dens: 2.4, t0: 0.004, life: 6 + rnd() * 3, fin: 0.02 });
    }
    for (let i = 0; i < 4; i++) {
      puffs.push({ x: pos.x + (rnd() - 0.5) * 0.1, y: pos.y + 0.05, z: pos.z + (rnd() - 0.5) * 0.1, vx: (rnd() - 0.5) * 0.6, vy: 0.4 + rnd() * 0.3, vz: (rnd() - 0.5) * 0.6, k: 1.2, rise: 0.08, r0: 0.08, r1: 0.6 + rnd() * 0.3, tau: 1.3, dens: 1.3, t0: 0.02, life: 9 + rnd() * 3, fin: 0.1 });
    }
    app.smoke.spawn(puffs, _col.setRGB(0.8, 0.8, 0.78), seed, 10);

    this.scorch.visible = pos.y < 0.5;
    this.scorch.position.set(pos.x, 0.0015, pos.z);

    // ослепление и звук считаются для живого просмотра
    this.blindness(app.camera);
    app.camera.getWorldQuaternion(this.capQuatInv).invert();
    this.captured = false;
    app.audio.blast('m84', { pos, seed, occlusion: this.occlusion, intensity: clamp(1 / (1 + this.dist / 4), 0, 1) });
    this.update(0, { mode: 'live' });
  }

  pulse(t) {
    // магниевая вспышка: быстрый фронт, спад ~30 мс, лёгкое мерцание
    if (t < 0) return 0;
    const rise = Math.min(1, t / 0.0025);
    return rise * (Math.exp(-t / 0.028) * (1 + 0.15 * Math.sin(t * 900)) + 0.08 * Math.exp(-t / 0.25));
  }

  update(t, { mode, slow = 1 } = {}) {
    if (!this.detonated) return false;
    const app = this.app, P = app.post.params, fs = app.safety.flashScale;
    const rig = app.rig;
    this.track.sample(t, rig.position, rig.quaternion);
    this.center.copy(rig.position);
    const pu = this.pulse(t);
    this.light.position.copy(rig.position);
    this.light.intensity = 26000 * pu * (0.3 + 0.7 * fs);
    // тень вспышки — только первые ~100 мс, дальше карта не обновляется
    if (t < 0.1) this.light.shadow.needsUpdate = true;
    this.after.position.copy(rig.position);
    this.after.intensity = 6 * Math.exp(-t / 0.9) * smooth(0, 0.02, t);
    app.model.setGlow && app.model.setGlow(80 * pu + 3 * Math.exp(-t / 0.7));
    this.sparks.time = t; this.jets.time = t;
    this.sparks.uniforms.uShutter.value = mode === 'replay' ? 1 / (60 * slow) : 1 / 90;
    this.jets.uniforms.uShutter.value = this.sparks.uniforms.uShutter.value;
    const ag = 0.8 * Math.exp(-t / 0.8);
    _col.setRGB(30 * pu + 1.2 * ag, 28.5 * pu + 0.55 * ag, 27 * pu + 0.2 * ag);
    app.smoke.update(t, app.stage.sunDir, rig.position, _col);
    this.scorch.material.opacity = 0.75 * smooth(0, 0.25, t);
    // физическая часть засветки (видна и в повторе)
    P.flash = 1.2 * pu * fs;
    P.flashTint.setRGB(1, 0.97, 0.92);
    P.bloomStrength = 0.05 + 0.25 * pu;
    P.chroma = 0;
    // ударная волна 170 дБ — заметное искажение
    const R = shockRadius(t);
    P.shock.center.copy(this.startPos);
    P.shock.radius = R; P.shock.width = 0.12 + 0.06 * R;
    P.shock.strength = R < 12 ? 0.5 * Math.exp(-R / 2.5) * (app.safety.reducedMotion ? 0.3 : 1) : 0;
    return t < this.duration;
  }

  // Глаз зрителя (только живой просмотр)
  applyEye(t, camera) {
    if (!this.detonated) return;
    const P = this.app.post.params, S = this.S, fs = this.app.safety.flashScale;
    if (!this.captured && t > 0.012) { this.app.post.captureAfterimage(); this.captured = true; }
    // белая пелена: пик во время вспышки, затем быстро спадает — дальше работают остаточное изображение и адаптация
    const veil = S * (160 * this.pulse(t) + 5 * Math.exp(-t / (0.35 + 1.2 * S)));
    P.flash += veil * fs;
    P.chroma = S * 0.9 * Math.exp(-t / 0.35) * (this.app.safety.reducedMotion ? 0 : 1) * (fs < 1 ? 0.3 : 1);
    P.adapt = 1 - 0.88 * S * Math.exp(-t / (3 + 7 * S)) * smooth(0.0, 0.4, t);
    P.after.strength = S * fs * smooth(0.25, 1.2, t) * Math.exp(-Math.max(0, t - 1) / (2 + 5 * S));
    // остаточное изображение «прилипает» к сетчатке: смещается против поворота камеры лишь на долю
    camera.getWorldQuaternion(_q);
    _q.premultiply(this.capQuatInv);
    _e.setFromQuaternion(_q, 'YXZ');
    const fov = THREE.MathUtils.degToRad(camera.fov);
    P.after.offset.set(_e.y / fov * 0.35, -_e.x / fov * 0.35);
  }

  shakeAt(t, camPos) {
    const d = camPos.distanceTo(this.startPos);
    const ta = d / 343;
    if (t < ta) return 0;
    return 1.4 / (1 + d * 1.5) * Math.exp(-(t - ta) / 0.22);
  }
}
