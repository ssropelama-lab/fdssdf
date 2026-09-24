// Склейка: сцена, механика (клип → чека → рычаг → ударник → замедлитель), ввод, бросок,
// взрыв, повтор, рендер по требованию, профили качества и стенд.
import * as THREE from 'three';
import { Stage, TABLE_TOP } from './scenes.js';
import { World, Body } from './physics.js';
import { GrenadeState, S, LABEL } from './state.js';
import { PostPipeline } from './post.js';
import { AudioEngine } from './audio.js';
import { Director } from './director.js';
import { PROFILES, guessProfile, DynamicResolution } from './quality.js';
import { GpuParticles, makeSmokeAtlas } from './particles.js';
import { SmokeSystem } from './smoke.js';
import { UI } from './ui.js';
import { Bench } from './bench.js';
import { mulberry32, newSeed, clamp, smooth } from './rng.js';

const GRAB_LAYER = 5;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _ndc = new THREE.Vector2(), _off = new THREE.Vector3(), _rot = new THREE.Euler();

const URLQ = new URLSearchParams(location.search);

export async function startApp(cfg) {
  const app = new GrenadeApp(cfg);
  try { await app.init(); } catch (e) { console.error(e); app.ui.fail('Ошибка запуска: ' + (e && e.message ? e.message : e)); throw e; }
  window.__app = app;
  return app;
}

class GrenadeApp {
  constructor(cfg) {
    this.cfg = cfg;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const opts = [
      { type: 'chips', key: 'scene', label: 'Сцена', value: URLQ.get('scene') || 'range', items: [['studio', 'Студия'], ['range', 'Полигон']] },
      { type: 'chips', key: 'camera', label: 'Камера', value: 'director', items: [['director', 'Режиссёр'], ['free', 'Свободная']] },
      { type: 'chips', key: 'quality', label: 'Качество', value: URLQ.get('q') || 'auto', items: [['auto', 'Авто'], ['low', 'Low'], ['med', 'Med'], ['high', 'High']] },
      { type: 'chips', key: 'tone', label: 'Тонмаппинг', value: 'agx', items: [['agx', 'AgX'], ['aces', 'ACES']] },
      { type: 'header', label: 'Опции' },
      { type: 'switch', key: 'reduceFlash', label: 'Ослабить вспышки', value: this.reducedMotion },
      { type: 'switch', key: 'tinnitus', label: 'Звон в ушах', value: false },
      ...(cfg.options || []),
    ];
    this.ui = new UI({ title: cfg.title, subtitle: cfg.subtitle, hint: cfg.hint, options: opts });
    this.state = new GrenadeState(cfg.hasClip);
    this.clock = 0;
    this.seed = URLQ.has('seed') ? Number(URLQ.get('seed')) >>> 0 : newSeed();
    this.dirty = true;
    this.accum = 0;
    this.replay = { active: false, t: 0, playing: false };
    this.pointer = { down: false, mode: null, x: 0, y: 0, sx: 0, sy: 0, samples: new Float32Array(3 * 12), ns: 0 };
    this.pinDrag = { u: 0, d: 0, broken: false, returning: false, axis2: new THREE.Vector2(), pxPerM: 1000, lastD: 0 };
    this.safety = { flashScale: 1, shake: this.reducedMotion ? 0 : 1, reducedMotion: this.reducedMotion };
  }

  async init() {
    const ui = this.ui;
    ui.progress(0.1, 'Инициализация WebGL 2…');
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    if (!renderer.capabilities.isWebGL2) throw new Error('нужен WebGL 2');
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true;
    renderer.info.autoReset = false;
    document.body.prepend(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', this.cfg.title);

    const qsel = ui.values.quality;
    this.gpuGuess = guessProfile(renderer);
    this.quality = PROFILES[qsel === 'auto' ? this.gpuGuess.profile : qsel] || PROFILES.med;
    this.dynres = new DynamicResolution();
    this.dynres.enabled = qsel === 'auto';

    this.camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 60);
    this.stage = new Stage(renderer);
    this.scene = this.stage.scene;
    this.world = new World();

    ui.progress(0.25, 'Постобработка…');
    this.post = new PostPipeline(renderer, this.quality);
    this.resize();
    this.fxScene = new THREE.Scene();
    this.atlas = makeSmokeAtlas(512);
    this.smoke = new SmokeSystem({ fxUniforms: this.post.fxUniforms, atlas: this.atlas });
    this.smoke.setQuality(this.quality);
    this.fxScene.add(this.smoke.sprites.mesh);
    this.post.volume = this.smoke.volumeHook;
    // дым капсюля и замедлителя — на часах приложения
    this.mech = new GpuParticles({ capacity: 768, kind: 'smoke', fxUniforms: this.post.fxUniforms, atlas: this.atlas, soft: 0.02, name: 'fuseSmoke' });
    this.fxScene.add(this.mech.mesh);

    ui.progress(0.4, 'Модель и запечка текстур…');
    this.model = await this.cfg.buildModel({ renderer, quality: this.quality.name });
    this.rig = new THREE.Group(); this.rig.name = 'grenadeRig';
    this.rig.add(this.model.group);
    this.scene.add(this.rig);
    this.setupParts();

    this.director = new Director(this.camera, renderer.domElement);
    this.director.wideDist = this.cfg.wideDist || 4;
    this.audio = new AudioEngine();

    ui.progress(0.6, 'Эффекты…');
    this.blast = this.cfg.createBlast(this);
    this.blast.prepare();
    this.applyScene(ui.values.scene, true);
    this.applyOptions();

    ui.progress(0.75, 'Прогрев шейдеров…');
    await this.warmup();

    this.bindInput();
    this.bindUI();
    addEventListener('resize', () => { this.resize(); this.dirty = true; });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.audio.suspend(); else { this.audio.resume(); this.last = performance.now() / 1000; this.dirty = true; }
    });
    this.bench = URLQ.get('bench') === '1' ? new Bench(renderer) : null;
    ui.progress(1, 'Готово');
    ui.ready();
    this.last = performance.now() / 1000;
    this.syncHud();
    requestAnimationFrame(this.loop);
    if (this.bench) this.runBench();
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
    idle(() => this.audio.prerender && this.audio.prerender());
  }

  /* ---------- детали и тела ---------- */
  setupParts() {
    const m = this.model;
    const b = m.body;
    this.gBody = new Body({ colliders: b.colliders, mass: b.mass, inertia: b.inertia, restitution: b.restitution ?? 0.3, friction: 0.6, rolling: b.rolling ?? 0.02 });
    this.gBody.onHit = (body, speed, p) => { this.audio.play('bodyHit', { pos: p, gain: clamp(speed / 5, 0.05, 1) }); };
    this.world.add(this.gBody);
    this.parts = {};
    for (const key of ['lever', 'pin', 'clip']) {
      const p = m[key];
      if (!p) continue;
      const home = { parent: p.obj.parent, pos: p.obj.position.clone(), quat: p.obj.quaternion.clone() };
      const com = new THREE.Vector3();
      for (const c of p.colliders) com.add(c.p);
      com.multiplyScalar(1 / p.colliders.length);
      const ext = new THREE.Vector3();
      for (const c of p.colliders) { ext.x = Math.max(ext.x, Math.abs(c.p.x - com.x) + c.r); ext.y = Math.max(ext.y, Math.abs(c.p.y - com.y) + c.r); ext.z = Math.max(ext.z, Math.abs(c.p.z - com.z) + c.r); }
      const I = new THREE.Vector3(p.mass * (ext.y * ext.y + ext.z * ext.z) / 3, p.mass * (ext.x * ext.x + ext.z * ext.z) / 3, p.mass * (ext.x * ext.x + ext.y * ext.y) / 3);
      const body = new Body({ colliders: p.colliders.map((c) => ({ p: c.p.clone().sub(com), r: c.r })), mass: p.mass, inertia: I, restitution: 0.35, friction: 0.45, rolling: 0.08, drag: 0.1, spinDrag: 0.3 });
      const snd = key === 'lever' ? 'leverHit' : key === 'pin' ? 'pinHit' : 'clipHit';
      body.onHit = (bd, speed, pt) => this.audio.play(snd, { pos: pt, gain: clamp(speed / 4, 0.05, 1) });
      this.world.add(body);
      const wrap = new THREE.Group(); wrap.name = key + 'Free';
      this.parts[key] = { def: p, home, com, body, wrap, free: false };
    }
    // невидимые «ручки» для попадания мышью по тонким деталям
    this.grab = [];
    const addGrab = (obj, r, tag, offset) => {
      if (!obj) return;
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), new THREE.MeshBasicMaterial());
      s.layers.set(GRAB_LAYER); s.userData.tag = tag;
      if (offset) s.position.copy(offset);
      obj.add(s); this.grab.push(s);
    };
    addGrab(m.pin?.ringObj || m.pin?.obj, 0.02, 'pin', m.pin?.ringCenter);
    if (m.clip) addGrab(m.clip.obj, 0.014, 'clip', m.clip.grabCenter);
    this.raycaster = new THREE.Raycaster();
    this.raycaster.layers.set(GRAB_LAYER);
  }

  restPose() {
    const m = this.model;
    this.rig.position.set(0, TABLE_TOP + m.body.restY, 0);
    this.rig.quaternion.setFromEuler(new THREE.Euler(0, this.cfg.restYaw || 0, 0));
    if (m.body.restQuat) this.rig.quaternion.multiply(m.body.restQuat);
    this.rig.updateMatrixWorld(true);
    this.gBody.pos.copy(this.rig.position); this.gBody.quat.copy(this.rig.quaternion);
    this.gBody.vel.set(0, 0, 0); this.gBody.ang.set(0, 0, 0);
    this.gBody.enabled = false; this.gBody.sleeping = false;
  }

  detach(key, vel, ang) {
    const P = this.parts[key];
    if (!P || P.free) return null;
    const obj = P.def.obj;
    obj.updateMatrixWorld(true);
    obj.getWorldQuaternion(P.wrap.quaternion);
    P.wrap.position.copy(P.com).applyMatrix4(obj.matrixWorld);
    this.scene.add(P.wrap);
    P.wrap.updateMatrixWorld(true);
    P.wrap.attach(obj);
    const b = P.body;
    b.pos.copy(P.wrap.position); b.quat.copy(P.wrap.quaternion);
    b.vel.copy(vel); b.ang.copy(ang);
    b.enabled = true; b.wake(); b.lastHit = -1;
    P.free = true;
    return P;
  }

  reattach(key) {
    const P = this.parts[key];
    if (!P) return;
    const obj = P.def.obj;
    P.home.parent.add(obj);
    obj.position.copy(P.home.pos); obj.quaternion.copy(P.home.quat);
    P.wrap.removeFromParent();
    P.body.enabled = false; P.free = false;
  }

  /* ---------- сцена и опции ---------- */
  applyScene(name, first) {
    this.stage.use(name, this.world);
    this.director.bounds = this.stage.statics.bounds;
    this.reset(first);
  }

  applyOptions() {
    const v = this.ui.values;
    this.safety.flashScale = v.reduceFlash ? 0.12 : 1;
    this.post.params.toneMapper = v.tone;
    this.director.mode = v.camera;
    this.audio.setTinnitus(!!v.tinnitus);
    if (this.model.cutaway) this.model.cutaway.set(!!v.cutaway);
    this.dirty = true;
  }

  setQuality(name) {
    this.dynres.enabled = name === 'auto';
    const q = PROFILES[name === 'auto' ? this.gpuGuess.profile : name] || PROFILES.med;
    this.quality = q;
    this.post.setQuality(q);
    this.smoke.setQuality(q);
    const key = this.stage.key;
    if (key.shadow.mapSize.x !== q.shadowSize) {
      key.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
      key.shadow.needsUpdate = true;
    }
    this.dynres.scale = 1; this.post.setResolutionScale(1);
    this.blast.setQuality && this.blast.setQuality(q);
    this.resize();
    this.dirty = true;
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, this.quality.dprCap);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(innerWidth, innerHeight, true);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.post.setSize(innerWidth, innerHeight, dpr);
  }

  /* ---------- прогрев: ни одной компиляции шейдера во время взрыва ---------- */
  async warmup() {
    const g = this.stage.groups;
    const vis = [g.studio.visible, g.range.visible];
    g.studio.visible = g.range.visible = true;
    this.blast.warm(true);
    this.smoke.warmState(this.rig.position);
    this.mech.mesh.visible = true;
    this.director.home(this.rig.position);
    this.camera.updateMatrixWorld();
    try {
      if (this.renderer.compileAsync) {
        await this.renderer.compileAsync(this.scene, this.camera);
        await this.renderer.compileAsync(this.fxScene, this.camera);
      } else { this.renderer.compile(this.scene, this.camera); this.renderer.compile(this.fxScene, this.camera); }
    } catch (e) { console.warn('compileAsync', e); }
    // один скрытый кадр со всеми эффектами (вкл. тени вспышки и объёмный дым)
    this.post.warmup(this.scene, this.fxScene, this.camera);
    this.blast.warm(false);
    this.smoke.clear();
    g.studio.visible = vis[0]; g.range.visible = vis[1];
    this.programsAfterWarm = this.renderer.info.programs.length;
  }

  /* ---------- жизненный цикл гранаты ---------- */
  reset(first) {
    this.exitReplay();
    for (const k of Object.keys(this.parts)) this.reattach(k);
    this.model.pin.set(0);
    this.model.lever.set && this.model.lever.set(0);
    if (this.model.clip) this.model.clip.set(true);
    this.model.group.visible = true;
    this.model.reset && this.model.reset();
    this.state.reset();
    this.restPose();
    this.blast.reset();
    this.smoke.clear();
    this.mech.clear(); this.mech.commit();
    this.audio.stopAll();
    Object.assign(this.pinDrag, { u: 0, d: 0, broken: false, returning: false, auto: null });
    this.tStriker = 0; this.fuseDelay = 0; this.tDet = 0; this.thrownAt = 0; this.leverAt = 0;
    this.seed = first && URLQ.has('seed') ? this.seed : newSeed();
    this.rnd = mulberry32(this.seed);
    const p = this.post.params;
    p.flash = 0; p.chroma = 0; p.adapt = 1; p.after.strength = 0; p.shock.strength = 0; p.haze.strength = 0;
    this.director.resetShots();
    this.director.home(this.rig.position, this.cfg.homeDist || 0.34);
    this.stage.setFocus(this.rig.position);
    this.dirty = true;
    this.syncHud();
  }

  removeClip() {
    if (!this.state.go(S.CLIP, this.clock)) return;
    const c = this.parts.clip;
    this.model.clip.set(false);
    _v.set(0.25 + this.rnd() * 0.2, 0.9, 0.2).applyQuaternion(this.rig.quaternion);
    _v2.set(this.rnd() * 20 - 10, this.rnd() * 20 - 10, 25);
    if (c) this.detach('clip', _v, _v2);
    this.audio.play('clip', { pos: this.rig.position });
    this.vibrate(12);
    this.syncHud();
  }

  // Кривая усилия чеки: подклинивание (отогнутые усики) → срыв → скольжение
  updatePin(dt) {
    const P = this.pinDrag, m = this.model;
    if (!this.state.is(S.CLIP, S.PIN)) return false;
    const travel = m.pin.travel;
    const uBreak = travel * 0.22;
    if (P.auto) {
      // автоматическое вытягивание (кнопка/Space): рывок с задержкой на срыве
      P.auto.t += dt;
      const t = P.auto.t;
      P.u = t < 0.35 ? uBreak * 1.02 * smooth(0, 0.35, t) : uBreak + (travel * 1.2 - uBreak) * smooth(0.35, 0.75, t);
    }
    if (P.returning) {
      P.d += (0 - P.d) * Math.min(1, dt * 18);
      if (P.d < 1e-5) { P.d = 0; P.returning = false; }
      m.pin.set(P.d);
      return true;
    }
    if (!P.active && !P.auto) return false;
    const prev = P.d;
    if (!P.broken) {
      P.d = travel * 0.05 * smooth(0, uBreak, P.u);
      if (P.u >= uBreak) {
        P.broken = true;
        this.audio.play('pinHit', { pos: this.rig.position, gain: 0.25 });
        this.vibrate(18);
      }
    } else {
      const target = P.u - uBreak * 0.3;
      if (target > P.d) P.d += (target - P.d) * Math.min(1, dt * 28);
    }
    const vel = (P.d - prev) / Math.max(1e-3, dt);
    this.audio.scrape.set(Math.abs(vel), P.broken ? 0.35 : clamp(P.u / uBreak, 0, 1));
    m.pin.set(Math.min(P.d, travel));
    if (P.d >= travel) this.pinOut(vel);
    return true;
  }

  beginPin() {
    if (this.state.phase === S.CLIP) this.state.go(S.PIN, this.clock);
    if (!this.state.is(S.PIN)) return false;
    this.pinDrag.active = true; this.pinDrag.returning = false;
    this.audio.scrape.start();
    this.syncHud();
    return true;
  }

  endPinDrag() {
    const P = this.pinDrag;
    P.active = false;
    this.audio.scrape.stop();
    if (this.state.is(S.PIN) && !P.broken) { P.returning = true; P.u = 0; }
  }

  pinOut(vel) {
    const P = this.pinDrag;
    P.active = false; P.auto = null;
    this.audio.scrape.stop();
    this.audio.play('ring', { pos: this.rig.position, gain: 0.8 });
    this.vibrate(30);
    // чека уходит по оси с остаточной скоростью руки
    _v.copy(this.model.pin.axis).applyQuaternion(this.rig.quaternion).multiplyScalar(clamp(vel, 0.4, 2.5));
    _v.y += 0.6;
    _v2.set(this.rnd() * 30 - 15, this.rnd() * 30 - 15, this.rnd() * 30 - 15);
    this.detach('pin', _v, _v2);
    this.state.go(S.HELD, this.clock);
    this.syncHud();
  }

  autoPull() {
    if (this.state.phase === S.READY) { this.removeClip(); return; }
    if (!this.beginPin()) return;
    this.pinDrag.auto = { t: 0 };
  }

  releaseLever() {
    if (!this.state.go(S.RELEASED, this.clock)) return;
    const m = this.model, L = this.parts.lever;
    this.leverAt = this.clock;
    // пружина ударника отбрасывает рычаг: вращение вокруг шарнира → свободный полёт
    const w = m.lever.kick || 95;
    _v3.copy(m.lever.axis).applyQuaternion(this.rig.quaternion).normalize();   // ось шарнира в мире
    const ang = _v2.copy(_v3).multiplyScalar(w);
    m.lever.set && m.lever.set(0.12);
    L.def.obj.updateMatrixWorld(true);
    const hinge = _v.copy(m.lever.hinge).applyMatrix4(this.model.group.matrixWorld);
    const com = _off.copy(L.com).applyMatrix4(L.def.obj.matrixWorld).sub(hinge);
    const vel = new THREE.Vector3().crossVectors(ang, com).add(this.gBody.enabled ? this.gBody.vel : _v.set(0, 0, 0));
    vel.y += 0.8;
    ang.x += (this.rnd() - 0.5) * 12; ang.z += (this.rnd() - 0.5) * 12;
    this.detach('lever', vel, ang);
    this.audio.play('spring', { pos: this.rig.position });
    this.audio.whoosh.start();
    this.vibrate(10);
    this.syncHud();
  }

  fireStriker() {
    if (!this.state.go(S.STRIKER, this.clock)) return;
    this.tStriker = this.clock;
    const [a, b] = this.cfg.fuse;
    this.fuseDelay = a + (b - a) * this.rnd();
    if (URLQ.has('fuse')) this.fuseDelay = Number(URLQ.get('fuse'));
    this.model.striker && this.model.striker(true);
    const vent = this.ventWorld(_v);
    this.audio.play('primer', { pos: vent });
    this.audio.fuse.start(vent, this.fuseDelay);
    // «пух» капсюля: маленькая струйка дыма из запала
    for (let i = 0; i < 14; i++) {
      const r = this.rnd;
      this.mech.emit(vent.x, vent.y, vent.z, (r() - 0.5) * 0.25, 0.25 + r() * 0.35, (r() - 0.5) * 0.25,
        this.clock + r() * 0.05, 1.4 + r() * 1.2, 2.5, -0.15, 0.006, 0.05 + r() * 0.05, 0.75, 0.74, 0.72, 0.5, 0, r(), 0, 0.05);
    }
    this.mech.commit();
    this.nextWisp = this.clock + 0.15;
    this.lastMechEmit = this.clock;
  }

  ventWorld(out) { return out.copy(this.model.fuzeVent).applyMatrix4(this.model.group.matrixWorld); }

  // Бросок: скорость из движения мыши (экранная скорость в высотах экрана/с)
  throwGrenade(vx, vy) {
    if (!this.state.pinOut || this.state.thrown || this.state.is(S.BLAST, S.AFTER)) return;
    const cam = this.camera;
    const fwd = _v.set(0, 0, -1).applyQuaternion(cam.quaternion).setY(0).normalize();
    const right = _v2.set(1, 0, 0).applyQuaternion(cam.quaternion).setY(0).normalize();
    const sp = Math.hypot(vx, vy);
    const speed = clamp(sp * 3.4, 2, 15);
    const up = clamp(-vy / Math.max(1e-3, sp), -0.3, 1);
    const dir = _v3.copy(fwd).multiplyScalar(Math.max(0.35, up)).addScaledVector(right, vx / Math.max(1e-3, sp)).normalize();
    const b = this.gBody;
    b.vel.copy(dir).multiplyScalar(speed * 0.92);
    b.vel.y = speed * (0.28 + 0.22 * Math.max(0, up));
    // вращение: M67 — вперёд-через-себя, M84 — кувырок
    _off.crossVectors(_v.set(0, 1, 0), dir).normalize().multiplyScalar(-(this.cfg.throwSpin || 12));
    b.ang.copy(_off).add(_v.set((this.rnd() - 0.5) * 4, (this.rnd() - 0.5) * 4, (this.rnd() - 0.5) * 4));
    b.pos.copy(this.rig.position).add(_v.set(0, 0.04, 0));
    b.quat.copy(this.rig.quaternion);
    b.enabled = true; b.wake(); b.lastHit = this.world.time;
    this.state.thrown = true; this.state.inHand = false;
    this.thrownAt = this.clock;
    if (this.state.is(S.HELD)) this.releaseLever();
    this.syncHud();
  }

  drop() {
    if (!this.state.pinOut || this.state.thrown) return;
    this.throwGrenade(0, 0.001);
    this.gBody.vel.set(0.15, 0.3, -0.2);
  }

  detonate() {
    this.state.go(S.BLAST, this.clock);
    this.tDet = this.clock;
    this.audio.fuse.stop();
    this.gBody.enabled = false;
    this.post.params.haze.strength = 0;
    this.bench && this.bench.mark('blast');
    this.blast.detonate({ seed: this.seed, pos: this.rig.position, quat: this.rig.quaternion, vel: this.gBody.vel, delay: this.fuseDelay });
    this.syncHud();
  }

  /* ---------- повтор ---------- */
  startReplay() {
    if (!this.blast.detonated || this.replay.active) return;
    this.replay.active = true; this.replay.playing = true; this.replay.t = 0;
    const r = this.cfg.replay;
    this.director.startReplay(this.blast.center, r.dist, r.height);
    this.replayAudio = this.audio.replay(this.cfg.id, true);
    this.ui.showReplay(true);
    this.syncHud();
    this.dirty = true;
  }
  exitReplay() {
    if (!this.replay.active) return;
    this.replay.active = false;
    this.replayAudio && this.replayAudio.stop && this.replayAudio.stop();
    this.director.endReplay();
    this.ui.showReplay(false);
    this.syncHud();
    this.dirty = true;
  }
  replayPos(t) { const d = this.blast.duration; return t <= 0 ? 0 : clamp(Math.log(t / 1e-6) / Math.log(d / 1e-6), 0, 1); }
  replayTime(p) { return p <= 0 ? 0 : 1e-6 * Math.pow(this.blast.duration / 1e-6, p); }

  /* ---------- кадр ---------- */
  loop = () => {
    requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const nowS = performance.now() / 1000;
    const rawDt = Math.max(0.0001, nowS - this.last);
    const dt = Math.min(0.05, rawDt);
    this.last = nowS;
    const t0 = performance.now();
    const active = this.update(dt);
    const r = this.renderer;
    let rendered = false;
    if (active || this.dirty) { this.accum = 0; this.render(0); rendered = true; }
    else if (this.accum < this.quality.accumMax) { this.accum++; this.render(this.accum); rendered = true; }
    this.dirty = false;
    const cpu = performance.now() - t0;
    if (rendered) {
      this.frameCount = (this.frameCount || 0) + 1;
      if (this.bench) this.bench.frame(rawDt * 1000, cpu, this.state.is(S.BLAST, S.AFTER) && this.clock - this.tDet < 1);
      if (active && this.dynres.push(rawDt * 1000)) this.post.setResolutionScale(this.dynres.scale);
      if (this.frameCount < 40 && this.frameCount > 10) this.dynres.calibrate(rawDt * 1000);
    }
    this.fpsAcc = (this.fpsAcc || 0) + dt; this.fpsN = (this.fpsN || 0) + (rendered ? 1 : 0);
    if (this.fpsAcc > 0.5) {
      const info = r.info;
      this.ui.stats(`${(this.fpsN / this.fpsAcc).toFixed(0)} fps · ${this.quality.name} · ×${this.post.info.scale.toFixed(1)}\n` +
        `вызовов ${info.render.calls} · треуг. ${info.render.triangles}\nшейдеров ${info.programs.length} · звук ${this.audio.stats?.nodes ?? 0} узл.\n` +
        `seed ${this.seed}${this.fuseDelay ? ` · задержка ${this.fuseDelay.toFixed(2)} с` : ''}`);
      this.fpsAcc = 0; this.fpsN = 0;
    }
  };

  update(dt) {
    this.clock += dt;
    const now = this.clock, st = this.state;
    let active = false;
    if (this.replay.active) {
      const R = this.replay;
      const slow = this.cfg.replay.slowdown(R.t);
      if (R.playing) {
        R.t += dt / slow;
        if (R.t >= this.blast.duration) { R.t = this.blast.duration; R.playing = false; }
      }
      this.blast.update(R.t, { mode: 'replay', slow, dtReal: dt });
      this.resetEye();
      this.ui.replayInfo(this.cfg.replay.label(R.t), this.cfg.replay.fpsLabel(slow), this.replayPos(R.t), R.playing);
      if (this.cfg.replay.distAt) this.director.setReplayDistance(this.cfg.replay.distAt(R.t));
      this.director.update(dt, this.dctx());
      return true;
    }
    active = this.updatePin(dt) || active;
    // физика
    const anyAwake = this.world.bodies.some((b) => b.enabled && !b.sleeping);
    if (anyAwake) { this.world.step(dt); active = true; }
    for (const k in this.parts) { const P = this.parts[k]; if (P.free) P.body.copyTo(P.wrap); }
    if (this.gBody.enabled) this.gBody.copyTo(this.rig);
    // рычаг летит — свист; ударник накалывает капсюль через несколько мс после отпускания
    if (st.is(S.RELEASED) && now - this.leverAt > 0.006) this.fireStriker();
    const L = this.parts.lever;
    if (L && L.free) {
      if (now - this.leverAt < 1.4 && !L.body.sleeping) this.audio.whoosh.set(L.body.ang.length() * 0.03 + L.body.vel.length(), L.wrap.position);
      else this.audio.whoosh.stop();
    }
    if (st.is(S.STRIKER) && now - this.tStriker > 0.03) st.go(S.FUSE, now);
    if (st.is(S.STRIKER, S.FUSE)) {
      active = true;
      const el = now - this.tStriker;
      const vent = this.ventWorld(_v);
      this.audio.fuse.setPos(vent);
      if (this.model.cutaway) this.model.cutaway.burn(clamp(el / this.fuseDelay, 0, 1));
      // марево над запалом и тонкая струйка дыма
      const h = this.post.params.haze;
      h.strength = 0.5 * smooth(0, 0.3, el); h.center.copy(vent).add(_v2.set(0, 0.035, 0)); h.radius = 0.035;
      if (now > this.nextWisp) {
        this.nextWisp = now + 0.09;
        const r = this.rnd;
        this.mech.emit(vent.x, vent.y, vent.z, (r() - 0.5) * 0.04, 0.12 + r() * 0.1, (r() - 0.5) * 0.04, now, 1.6, 1.5, -0.12, 0.005, 0.035, 0.7, 0.7, 0.7, 0.18, 0, r(), 0, 0.1);
        this.mech.commit();
        this.lastMechEmit = now;
      }
      if (el >= this.fuseDelay) this.detonate();
    }
    if (st.is(S.BLAST, S.AFTER)) {
      const tb = now - this.tDet;
      const on = this.blast.update(tb, { mode: 'live', slow: 1, dtReal: dt });
      this.blast.applyEye && this.blast.applyEye(tb, this.camera);
      if (st.is(S.BLAST) && tb > 0.6) { st.go(S.AFTER, now); this.syncHud(); }
      if (this.bench && tb > 6 && !this.benchDone) this.finishBench();
      active = active || on || this.eyeActive();
    }
    this.mech.time = now;
    if (this.mech.count && now - (this.lastMechEmit || 0) < 4) active = true;
    // фокус камеры/тени
    const focus = st.is(S.BLAST, S.AFTER) ? this.blast.center : this.rig.position;
    if (this.stage.setFocus(focus)) active = true;
    const moved = this.director.update(dt, this.dctx());
    this.syncHudLive();
    return active || moved || this.pointer.down;
  }

  eyeActive() { const p = this.post.params; return p.flash > 1e-3 || p.after.strength > 1e-3 || p.adapt < 0.999 || p.chroma > 1e-3; }
  resetEye() { const p = this.post.params; p.after.strength = 0; p.adapt = 1; }

  dctx() {
    const d = this._dctx || (this._dctx = { focus: new THREE.Vector3(), vel: new THREE.Vector3() });
    const blasted = this.state.is(S.BLAST, S.AFTER);
    d.focus.copy(blasted ? this.blast.center : this.rig.position);
    d.vel.copy(this.gBody.vel);
    d.speed = this.gBody.enabled && !this.gBody.sleeping ? this.gBody.vel.length() : 0;
    d.thrown = this.state.thrown || blasted;
    d.thrownFor = this.clock - this.thrownAt;
    d.blasted = blasted;
    d.fuseLeft = this.state.is(S.STRIKER, S.FUSE) ? this.fuseDelay - (this.clock - this.tStriker) : 99;
    return d;
  }

  render(accum) {
    const r = this.renderer;
    r.info.reset();
    let shaken = false;
    if (!this.replay.active && this.state.is(S.BLAST, S.AFTER) && this.safety.shake > 0) {
      const tb = this.clock - this.tDet;
      const amp = this.blast.shakeAt(tb, this.camera.position) * this.safety.shake;
      if (amp > 1e-5) {
        const f = tb * 43;
        _off.set(Math.sin(f * 1.3) + Math.sin(f * 2.9) * 0.5, Math.sin(f * 1.7 + 1) + Math.sin(f * 3.3) * 0.4, Math.sin(f * 1.1 + 2)).multiplyScalar(amp * 0.02);
        _rot.set(Math.sin(f * 2.1) * amp * 0.012, Math.sin(f * 1.6 + 3) * amp * 0.012, Math.sin(f * 1.2) * amp * 0.02);
        this.director.applyShake(_off, _rot);
        shaken = true;
      }
    }
    this.bench && this.bench.gpuBegin();
    this.post.render(this.scene, this.fxScene, this.camera, 1 / 60, accum);
    this.bench && this.bench.gpuEnd();
    if (shaken) this.director.removeShake();
  }

  /* ---------- HUD ---------- */
  nextAction() {
    const st = this.state;
    if (this.replay.active) return ['', true];
    switch (st.phase) {
      case S.READY: return ['Снять клип', false];
      case S.CLIP: case S.PIN: return ['Выдернуть чеку', false];
      case S.HELD: return ['Отпустить рычаг', false];
      case S.RELEASED: case S.STRIKER: case S.FUSE: return st.thrown ? ['Сброс', true] : ['Бросить', false];
      case S.AFTER: return [this.blast.detonated ? 'Повтор · слоу-мо' : 'Сброс', false];
      default: return ['Сброс', true];
    }
  }
  syncHud() {
    const [label, soft] = this.nextAction();
    this.ui.action(label, soft);
    const st = this.state;
    const cls = st.is(S.READY, S.CLIP) ? '' : st.is(S.PIN, S.HELD) ? 'warn' : st.is(S.AFTER) ? 'cold' : 'hot';
    this._hudCls = cls;
    const hints = {
      ready: this.cfg.hasClip ? 'Кликни по клипу, чтобы снять его. Space — следующее действие, R — сброс.' : '',
      clip: 'Потяни кольцо мышью вдоль оси чеки. Отпустишь до срыва — чека вернётся.',
      pin: 'Тяни дальше: после срыва чека выходит легко.',
      held: 'Кнопка мыши зажата — рычаг удержан. Резко смахни и отпусти — бросок, медленно отпусти — рычаг отлетит в руке.',
      released: 'Замедлитель горит. Смахни мышью, чтобы бросить (T — бросок вперёд, D — уронить).',
      striker: 'Замедлитель горит. Смахни мышью, чтобы бросить (T — бросок вперёд, D — уронить).',
      fuse: 'Замедлитель горит. Смахни мышью, чтобы бросить (T — бросок вперёд, D — уронить).',
      blast: '', after: 'Space — повтор в слоу-мо, R — заново.',
    };
    this.ui.hint(this.cfg.hint + (hints[st.phase] ? '<br>' + hints[st.phase] : ''));
    this.syncHudLive(true);
  }
  syncHudLive(force) {
    const st = this.state;
    let text = LABEL[st.phase];
    if (st.phase === S.CLIP && !this.cfg.hasClip) text = 'Готова · чека на месте';
    if (this.replay.active) text = 'Повтор · скоростная камера';
    if (st.is(S.STRIKER, S.FUSE)) text += ` · ${(this.clock - this.tStriker).toFixed(1)} с`;
    if (st.is(S.BLAST, S.AFTER) && this.fuseDelay) text = `${LABEL[st.phase]} · задержка была ${this.fuseDelay.toFixed(2)} с`;
    if (st.thrown && !st.is(S.BLAST, S.AFTER)) text += ' · брошена';
    else if (st.pinOut && st.inHand && !st.is(S.BLAST, S.AFTER)) text += ' · в руке';
    this.ui.status(text, this._hudCls);
  }

  primaryAction() {
    this.audio.unlock();
    const st = this.state;
    if (this.replay.active) return;
    switch (st.phase) {
      case S.READY: this.removeClip(); break;
      case S.CLIP: case S.PIN: this.autoPull(); break;
      case S.HELD: this.releaseLever(); break;
      case S.RELEASED: case S.STRIKER: case S.FUSE: if (st.thrown) this.reset(); else this.throwGrenade(0, -1.8); break;
      case S.AFTER: if (this.blast.detonated) this.startReplay(); else this.reset(); break;
      default: this.reset();
    }
    this.dirty = true;
  }

  vibrate(ms) { if (navigator.vibrate && matchMedia('(pointer: coarse)').matches) try { navigator.vibrate(ms); } catch { /* нет */ } }

  /* ---------- ввод ---------- */
  pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    _ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(_ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.grab, false);
    return hits.length ? hits[0].object.userData.tag : null;
  }

  // Проекция оси чеки на экран: сколько пикселей на метр вытягивания
  pinScreenAxis() {
    const m = this.model;
    const a = _v.copy(m.pin.anchor).applyMatrix4(m.group.matrixWorld);
    const b = _v2.copy(m.pin.anchor).addScaledVector(m.pin.axis, m.pin.travel).applyMatrix4(m.group.matrixWorld);
    a.project(this.camera); b.project(this.camera);
    const dx = (b.x - a.x) * innerWidth / 2, dy = -(b.y - a.y) * innerHeight / 2;
    const len = Math.hypot(dx, dy);
    const P = this.pinDrag;
    if (len < 4) P.axis2.set(1, 0); else P.axis2.set(dx / len, dy / len);
    P.pxPerM = Math.max(len, 70) / m.pin.travel;
  }

  sample(e) {
    const p = this.pointer, i = (p.ns++ % 12) * 3;
    p.samples[i] = e.clientX; p.samples[i + 1] = e.clientY; p.samples[i + 2] = performance.now();
  }
  flickVelocity(out) {
    // скорость по последним ~90 мс, в высотах экрана в секунду
    const p = this.pointer, n = Math.min(p.ns, 12), now = performance.now();
    let x1 = 0, y1 = 0, t1 = 0, x0 = 0, y0 = 0, t0 = 0, found = false;
    for (let k = 0; k < n; k++) {
      const i = ((p.ns - 1 - k) % 12) * 3;
      const t = p.samples[i + 2];
      if (k === 0) { x1 = p.samples[i]; y1 = p.samples[i + 1]; t1 = t; if (now - t > 60) break; }
      if (t1 - t > 90) break;
      x0 = p.samples[i]; y0 = p.samples[i + 1]; t0 = t; found = true;
    }
    const dt = (t1 - t0) / 1000;
    if (!found || dt < 0.008) return out.set(0, 0);
    return out.set((x1 - x0) / dt / innerHeight, (y1 - y0) / dt / innerHeight);
  }

  bindInput() {
    const el = this.renderer.domElement, p = this.pointer;
    const flick = new THREE.Vector2();
    el.addEventListener('pointerdown', (e) => {
      this.audio.unlock();
      if (this.replay.active || e.button > 0) return;
      const st = this.state;
      p.ns = 0; this.sample(e);
      p.sx = p.x = e.clientX; p.sy = p.y = e.clientY;
      let mode = null;
      const tag = this.pick(e);
      if (tag === 'clip' && st.is(S.READY)) { this.removeClip(); mode = 'none'; }
      else if (tag === 'pin' && st.is(S.CLIP, S.PIN) && this.beginPin()) { mode = 'pin'; this.pinScreenAxis(); this.pinDrag.u0 = this.pinDrag.u; }
      else if (st.pinOut && !st.thrown && !st.is(S.BLAST, S.AFTER)) mode = 'throw';
      if (mode) {
        p.down = true; p.mode = mode;
        this.director.controls.enabled = false;
        el.setPointerCapture(e.pointerId);
        e.preventDefault(); e.stopImmediatePropagation();
      }
      this.dirty = true;
    }, { capture: true });
    el.addEventListener('pointermove', (e) => {
      if (!p.down) {
        const tag = this.state.is(S.READY, S.CLIP, S.PIN) ? this.pick(e) : null;
        el.style.cursor = tag && ((tag === 'clip' && this.state.is(S.READY)) || (tag === 'pin' && !this.state.is(S.READY))) ? 'pointer' : '';
        return;
      }
      this.sample(e);
      p.x = e.clientX; p.y = e.clientY;
      if (p.mode === 'pin' && this.state.is(S.PIN)) {
        const P = this.pinDrag;
        const du = ((p.x - p.sx) * P.axis2.x + (p.y - p.sy) * P.axis2.y) / P.pxPerM;
        P.u = Math.max(0, P.u0 + du);
      }
      // после выхода чеки та же зажатая кнопка держит рычаг, движение — замах
      if (p.mode === 'pin' && this.state.is(S.HELD)) p.mode = 'throw';
    });
    const up = (e) => {
      if (!p.down) return;
      p.down = false;
      this.director.controls.enabled = true;
      const st = this.state;
      if (p.mode === 'pin' && st.is(S.PIN)) this.endPinDrag();
      else if (p.mode === 'throw' || (p.mode === 'pin' && st.is(S.HELD))) {
        this.flickVelocity(flick);
        const fast = flick.length() > 0.9 && e.type !== 'pointercancel';
        if (fast) this.throwGrenade(flick.x, flick.y);
        else if (st.is(S.HELD)) this.releaseLever();
      }
      p.mode = null;
      this.dirty = true;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    addEventListener('keydown', (e) => {
      if (e.target && /INPUT|BUTTON|SELECT/.test(e.target.tagName) && e.code === 'Space') return;
      this.audio.unlock();
      if (e.code === 'Space') { e.preventDefault(); if (this.state.is(S.AFTER) && this.replay.active) this.replay.playing = !this.replay.playing; else this.primaryAction(); }
      else if (e.code === 'KeyR') this.reset();
      else if (e.code === 'KeyT') { if (this.state.pinOut) this.throwGrenade(0, -1.8); }
      else if (e.code === 'KeyD') this.drop();
      else if (e.code === 'KeyM') this.toggleMute();
      else if (e.code === 'Escape') { this.exitReplay(); this.ui.togglePanel(false); }
      this.dirty = true;
    });
  }

  toggleMute() { this.muted = !this.muted; this.audio.setMuted(this.muted); this.ui.muted(this.muted); }

  bindUI() {
    const ui = this.ui;
    ui.on('action', () => this.primaryAction());
    ui.on('mute', () => { this.audio.unlock(); this.toggleMute(); });
    ui.on('replayPause', () => { if (this.replay.t >= this.blast.duration) this.replay.t = 0; this.replay.playing = !this.replay.playing; this.dirty = true; });
    ui.on('replayRestart', () => { this.replay.t = 0; this.replay.playing = true; this.replayAudio && this.replayAudio.stop && this.replayAudio.stop(); this.replayAudio = this.audio.replay(this.cfg.id, true); });
    ui.on('replayExit', () => this.exitReplay());
    ui.on('replayScrub', (pos) => { this.replay.t = this.replayTime(pos); this.replay.playing = false; this.dirty = true; });
    ui.on('option', (key, v) => {
      if (key === 'scene') this.applyScene(v);
      else if (key === 'quality') this.setQuality(v);
      else this.applyOptions();
      this.dirty = true;
    });
  }

  /* ---------- стенд ---------- */
  async runBench() {
    const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
    const until = async (f) => { while (!f()) await wait(0.05); };
    this.ui.benchReport('Стенд: прогрев…');
    await wait(1.5);
    this.bench.start();
    if (this.state.is(S.READY)) this.removeClip();
    await wait(0.4);
    this.autoPull();
    await until(() => this.state.is(S.HELD));
    await wait(0.3);
    this.releaseLever();
    await until(() => this.state.is(S.FUSE));
    await wait(0.2);
    this.throwGrenade(0.05, -1.6);
    this.ui.benchReport('Стенд: ждём подрыв…');
  }
  finishBench() {
    this.benchDone = true;
    const res = this.bench.report({
      grenade: this.cfg.id, quality: this.quality.name, gpu: this.gpuGuess.gpu, resolution_scale: this.post.info.scale,
      canvas: `${this.renderer.domElement.width}×${this.renderer.domElement.height}`, fuse_s: +this.fuseDelay.toFixed(3),
      programs_after_warmup: this.programsAfterWarm, audio_nodes: this.audio.stats?.nodes,
    });
    this.ui.benchReport('?bench=1\n' + JSON.stringify(res, null, 2));
  }
}
