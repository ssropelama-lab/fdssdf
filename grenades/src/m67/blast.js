// Взрыв M67 без голливуда: HDR-вспышка на 1–3 кадра, огненный шар ≤1 м на 30–60 мс,
// тёмный дым с сажей, кольцо пыли от ударной волны, осколки (Вороного) с попаданиями по расписанию.
// Всё — функции времени от seed: живой просмотр и слоу-мо повтор читают одно и то же состояние.
import * as THREE from 'three';
import { GpuParticles, PF } from '../core/particles.js';
import { mulberry32, clamp, smooth, hash3f, GLSL_HASH } from '../core/rng.js';

const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3(), _r = new THREE.Vector3(), _col = new THREE.Color();
const _h = [0, 0, 0];

// Хронология корпуса (реальные секунды)
export const T = { swell0: 4e-6, crack0: 12e-6, sep: 28e-6 };
export const shockRadius = (t) => 343 * t + 0.95 * (1 - Math.exp(-t / 0.00035));
// в повторе огонь приглушён, как у скоростной камеры с короткой выдержкой
const rk0 = (mode) => (mode === 'replay' ? 0.3 : 1);

function shockTime(r) {
  // обратная функция R(t) методом Ньютона
  let t = r / 2000;
  for (let i = 0; i < 8; i++) {
    const f = shockRadius(t) - r, df = 343 + (0.95 / 0.00035) * Math.exp(-t / 0.00035);
    t = Math.max(0, t - f / df);
  }
  return t;
}

const FRAG_VERT_PARS = /* glsl */`
attribute vec3 aDir;
attribute vec3 aAxis;
attribute vec4 aFrag;   // скорость, t попадания, угловая скорость, дистанция попадания
attribute vec3 aScale;
uniform float uT, uTsep, uR0;
uniform vec3 uCenter;
varying float vHeat;
vec3 rotAxis(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
`;
const FRAG_BEGIN = /* glsl */`
float tf = uT - uTsep;
float fly = min(max(tf, 0.0), aFrag.y - uTsep);
float dist = min(uR0 + aFrag.x * fly, aFrag.w);
float ang = aFrag.z * fly;
float alive = step(0.0, tf) * (1.0 - step(aFrag.y + 3.0, uT));
vec3 transformed = rotAxis(position * aScale, aAxis, ang) * alive + uCenter + aDir * dist;
vHeat = exp(-max(tf, 0.0) / 0.004);
`;

const CRACK_FRAG_PARS = /* glsl */`
uniform float uCrack, uCrackGlow, uCellS;
varying vec3 vObjPos;
${GLSL_HASH}
vec2 voronoiEdge(vec3 p) {
  ivec3 c0 = ivec3(floor(p));
  float f1 = 1e9, f2 = 1e9;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec3 c = c0 + ivec3(x, y, z);
    vec3 fp = vec3(c) + hash3f(c);
    float d = distance(p, fp);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
  }
  return vec2(f1, f2);
}
`;

export class M67Blast {
  constructor(app) {
    this.app = app;
    this.center = new THREE.Vector3();
    this.detonated = false;
    this.duration = 14;
  }

  prepare() {
    const app = this.app, fx = app.post.fxUniforms;
    this.light = new THREE.PointLight(0xffd7a8, 0, 25, 2);
    app.scene.add(this.light);
    this.flashP = new GpuParticles({ capacity: 512, kind: 'glow', fxUniforms: fx, soft: 0.05, name: 'm67Fire' });
    this.sparks = new GpuParticles({ capacity: 8192, kind: 'spark', fxUniforms: fx, name: 'm67Sparks' });
    this.streaks = new GpuParticles({ capacity: 1024, kind: 'spark', fxUniforms: fx, name: 'm67Streaks' });
    this.dust = new GpuParticles({ capacity: 4096, kind: 'smoke', fxUniforms: fx, atlas: app.atlas, soft: 0.08, name: 'm67Dust' });
    app.fxScene.add(this.flashP.mesh, this.sparks.mesh, this.streaks.mesh, this.dust.mesh);
    this.buildShell();
    this.buildDecals(1024);
    this.buildFragments(app.quality.fragments);
    this.patchBody();
  }

  setQuality(q) { this.wantFragments = q.fragments; }

  /* ---- видимая сфера ударной волны (заметна в повторе) ---- */
  buildShell() {
    const fx = this.app.post.fxUniforms;
    this.shellU = { uStrength: { value: 0 }, tDepth: fx.tDepth, uCamNear: fx.uCamNear, uCamFar: fx.uCamFar, uFxRes: fx.uFxRes };
    const mat = new THREE.ShaderMaterial({
      name: 'shockShell', uniforms: this.shellU, transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      vertexShader: `varying vec3 vN; varying vec3 vV; varying float vZ;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); vZ = -mv.z; gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform float uStrength, uCamNear, uCamFar; uniform sampler2D tDepth; uniform vec2 uFxRes; varying vec3 vN; varying vec3 vV; varying float vZ;
        void main(){ float d = texture2D(tDepth, gl_FragCoord.xy/uFxRes).r; float z = uCamNear*uCamFar/(uCamFar - d*(uCamFar-uCamNear));
          if (vZ > z) discard; float rim = pow(1.0 - abs(dot(vN, vV)), 4.0);
          gl_FragColor = vec4(vec3(0.55,0.62,0.7) * rim * uStrength, 0.0); }`,
    });
    this.shell = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.shell.frustumCulled = false;
    this.app.fxScene.add(this.shell);
  }

  /* ---- следы попаданий: появляются в момент t_hit ---- */
  buildDecals(n) {
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index; g.attributes.position = base.attributes.position; g.attributes.uv = base.attributes.uv;
    this.decA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);   // pos, t
    this.decB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);   // normal, size
    g.setAttribute('dA', this.decA); g.setAttribute('dB', this.decB);
    g.instanceCount = 0;
    this.decU = { uT: { value: 0 } };
    const mat = new THREE.ShaderMaterial({
      name: 'hitDecals', uniforms: this.decU, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
      vertexShader: `attribute vec4 dA; attribute vec4 dB; uniform float uT; varying vec2 vUv; varying float vAge;
        void main(){ vUv = uv; vAge = uT - dA.w; vec3 n = normalize(dB.xyz);
          vec3 t = normalize(abs(n.y) < 0.9 ? cross(n, vec3(0.,1.,0.)) : cross(n, vec3(1.,0.,0.))); vec3 b = cross(n, t);
          float s = vAge < 0.0 ? 0.0 : dB.w; vec3 p = dA.xyz + n * 0.0015 + (t * position.x + b * position.y) * s;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0); }`,
      fragmentShader: `varying vec2 vUv; varying float vAge;
        void main(){ if (vAge < 0.0) discard; float r = length(vUv - 0.5) * 2.0; float a = smoothstep(1.0, 0.25, r);
          vec3 hot = vec3(6.0, 1.8, 0.4) * exp(-vAge / 0.12) * smoothstep(0.5, 0.0, r);
          gl_FragColor = vec4(vec3(0.03, 0.028, 0.026) * (1.0 - smoothstep(0.35, 1.0, r) * 0.6) + hot, a * 0.85); }`,
    });
    this.decals = new THREE.Mesh(g, mat);
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 2;
    this.app.scene.add(this.decals);
    this.decalCap = n;
  }

  /* ---- осколки: заранее разбитый по ячейкам Вороного корпус, один инстансированный вызов ---- */
  cellScale(n) { return Math.sqrt(n / (4 * Math.PI * 1.8)); }

  buildFragments(n) {
    if (this.frag) { this.app.scene.remove(this.frag); this.frag.geometry.dispose(); }
    this.cellS = this.cellScale(n);
    // точки Вороного — те же, что в шейдере трещин (hash3f), только около сферы радиуса S
    const S = this.cellS, dirs = [];
    const R = Math.ceil(S) + 2;
    for (let z = -R; z <= R; z++) for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
      hash3f(x, y, z, _h);
      const px = x + _h[0], py = y + _h[1], pz = z + _h[2];
      const l = Math.hypot(px, py, pz);
      if (Math.abs(l - S) < 0.9) dirs.push(px / l, py / l, pz / l);
    }
    const count = dirs.length / 3;
    this.fragDirs = new Float32Array(dirs);
    this.fragCount = count;
    // базовая форма: сплюснутый неровный многогранник (стенка ~3 мм)
    const ico = new THREE.IcosahedronGeometry(1, 0);   // уже неиндексированная — нормали граней плоские
    const pos = ico.attributes.position;
    const rnd = mulberry32(7);
    const jit = new Map();
    for (let i = 0; i < pos.count; i++) {
      const k = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      if (!jit.has(k)) jit.set(k, 0.65 + rnd() * 0.6);
      const s = jit.get(k);
      pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s * 0.45, pos.getZ(i) * s);
    }
    ico.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a4a42, metalness: 0.75, roughness: 0.42, emissive: 0xff5a14, emissiveIntensity: 1 });
    this.fragU = { uT: { value: -1 }, uTsep: { value: T.sep }, uR0: { value: 0.03 }, uCenter: { value: new THREE.Vector3() } };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.fragU);
      sh.vertexShader = FRAG_VERT_PARS + sh.vertexShader
        .replace('#include <begin_vertex>', FRAG_BEGIN)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = rotAxis(normal, aAxis, aFrag.z * min(max(uT - uTsep, 0.0), aFrag.y - uTsep));');
      sh.fragmentShader = 'varying float vHeat;\n' + sh.fragmentShader
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance *= vHeat * 3.0;');
    };
    mat.customProgramCacheKey = () => 'm67frag';
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = null;
    geo.setAttribute('position', ico.attributes.position);
    geo.setAttribute('normal', ico.attributes.normal);
    this.fA = { dir: new THREE.InstancedBufferAttribute(this.fragDirs, 3), axis: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
      frag: new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4), scale: new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3) };
    geo.setAttribute('aDir', this.fA.dir); geo.setAttribute('aAxis', this.fA.axis); geo.setAttribute('aFrag', this.fA.frag); geo.setAttribute('aScale', this.fA.scale);
    geo.instanceCount = count;
    this.frag = new THREE.Mesh(geo, mat);
    this.frag.frustumCulled = false;
    this.frag.name = 'fragments';
    this.app.scene.add(this.frag);
    this.hitP = new Float32Array(count * 3); this.hitN = new Float32Array(count * 3);
    this.fragU.uT.value = -1;
  }

  /* ---- раздутие и трещины корпуса в слоу-мо ---- */
  patchBody() {
    const mesh = this.app.model.bodyMesh;
    if (!mesh) return;
    const mat = mesh.material;
    this.bodyU = { uSwell: { value: 1 }, uCrack: { value: 0 }, uCrackGlow: { value: 0 }, uCellS: { value: this.cellS } };
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev && prev.call(mat, sh, r);
      Object.assign(sh.uniforms, this.bodyU);
      sh.vertexShader = 'uniform float uSwell;\nvarying vec3 vObjPos;\n' + sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vObjPos = position; transformed *= uSwell;');
      sh.fragmentShader = CRACK_FRAG_PARS + sh.fragmentShader
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          if (uCrack > 0.0) {
            vec2 f = voronoiEdge(normalize(vObjPos) * uCellS);
            float e = f.y - f.x;
            float w = uCrack * 0.22;
            float crack = 1.0 - smoothstep(w * 0.5, w, e);
            diffuseColor.rgb *= 1.0 - 0.9 * crack;
            totalEmissiveRadiance += vec3(1.0, 0.72, 0.4) * crack * uCrackGlow;
          }`);
    };
    mat.customProgramCacheKey = () => 'm67body';
    mat.needsUpdate = true;
  }

  warm(on) {
    if (!on) { this.reset(); return; }
    const p = this.app.rig.position;
    this.light.intensity = 1; this.light.position.copy(p);
    for (const s of [this.flashP, this.sparks, this.streaks, this.dust]) {
      s.clear(); s.emit(p.x, p.y, p.z, 0, 0, 0, 0, 1e6, 0, 0, 0.01, 0.01, 1, 1, 1, 1); s.commit(); s.time = 1;
    }
    this.fragU.uT.value = T.sep + 1e-5; this.fragU.uCenter.value.copy(p);
    this.decU.uT.value = 1; this.decals.geometry.instanceCount = 1;
    this.decA.array.set([p.x, p.y, p.z, 0]); this.decB.array.set([0, 1, 0, 0.01]); this.decA.needsUpdate = this.decB.needsUpdate = true;
    this.shell.visible = true; this.shell.position.copy(p); this.shellU.uStrength.value = 0.01;
    if (this.bodyU) { this.bodyU.uCrack.value = 0.5; this.bodyU.uSwell.value = 1; }
  }

  reset() {
    this.detonated = false;
    this.light.intensity = 0;
    for (const s of [this.flashP, this.sparks, this.streaks, this.dust]) { s.clear(); s.commit(); }
    this.fragU.uT.value = -1;
    this.decals.geometry.instanceCount = 0;
    this.shell.visible = false;
    if (this.bodyU) { this.bodyU.uCrack.value = 0; this.bodyU.uSwell.value = 1; this.bodyU.uCrackGlow.value = 0; }
    if (this.wantFragments && this.wantFragments !== this.builtFor) { this.buildFragments(this.wantFragments); this.builtFor = this.wantFragments; if (this.bodyU) this.bodyU.uCellS.value = this.cellS; }
  }

  detonate({ seed, pos }) {
    const app = this.app, q = app.quality, w = app.world;
    this.reset();
    this.detonated = true;
    this.center.copy(pos);
    this.startPos = this.startPos || new THREE.Vector3();
    this.startPos.copy(pos);
    const rnd = mulberry32(seed ^ 0x67);
    const R0 = (app.model.dims?.R || 0.03175) * 1.55;
    this.fragU.uR0.value = R0; this.fragU.uCenter.value.copy(pos);

    // осколки: точка и момент попадания считаются один раз (луч против пола/стен, t = d/v)
    const n = this.fragCount, D = this.fragDirs, F = this.fA.frag.array, AX = this.fA.axis.array, SC = this.fA.scale.array;
    const st = this.streaks, sp = this.sparks, du = this.dust;
    st.clear(); sp.clear(); du.clear();
    const decA = this.decA.array, decB = this.decB.array;
    let nd = 0;
    const sparkK = q.sparks;
    for (let i = 0; i < n; i++) {
      _d.set(D[i * 3], D[i * 3 + 1], D[i * 3 + 2]);
      const size = 0.0022 + rnd() * rnd() * 0.005;
      const v = 1650 - (size - 0.0022) * 90000 + (rnd() - 0.5) * 120;
      _v.copy(pos).addScaledVector(_d, R0);
      let dist = w.raycast(_v, _d, 40, _n);
      const hit = dist > 0;
      if (!hit) dist = 40;
      const dHit = R0 + dist;
      const tHit = T.sep + dist / v;
      F[i * 4] = v; F[i * 4 + 1] = tHit; F[i * 4 + 2] = (rnd() - 0.5) * 9000; F[i * 4 + 3] = dHit;
      _r.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
      AX[i * 3] = _r.x; AX[i * 3 + 1] = _r.y; AX[i * 3 + 2] = _r.z;
      SC[i * 3] = size * (0.7 + rnd() * 0.6); SC[i * 3 + 1] = size; SC[i * 3 + 2] = size * (0.7 + rnd() * 0.6);
      // штрих с размытием движения: длина = скорость × выдержка
      st.emit(_v.x, _v.y, _v.z, _d.x * v, _d.y * v, _d.z * v, T.sep, tHit - T.sep, 0, 0, 0.0016, 0.0016, 2.2, 1.3, 0.7, 1, 1, rnd(), 0, 0);
      if (!hit) continue;
      const hx = pos.x + _d.x * dHit, hy = pos.y + _d.y * dHit, hz = pos.z + _d.z * dHit;
      // искры рикошета
      const dn = _d.dot(_n);
      _r.copy(_d).addScaledVector(_n, -2 * dn);
      const ns = Math.round((2 + rnd() * 5) * sparkK);
      for (let k = 0; k < ns; k++) {
        const s = 2 + rnd() * 7;
        sp.emit(hx + _n.x * 0.004, hy + _n.y * 0.004, hz + _n.z * 0.004,
          (_r.x + (rnd() - 0.5) * 0.9) * s + _n.x * rnd() * 2, (_r.y + (rnd() - 0.5) * 0.9) * s + _n.y * rnd() * 2, (_r.z + (rnd() - 0.5) * 0.9) * s + _n.z * rnd() * 2,
          tHit, 0.08 + rnd() * 0.3, 3, 9.81, 0.0045, 0.002, 9, 5.5, 2.4, 1, 1, rnd(), PF.FLOOR, 0);
      }
      // фонтанчик пыли
      if (rnd() < 0.85) {
        du.emit(hx + _n.x * 0.01, hy + _n.y * 0.01, hz + _n.z * 0.01, _n.x * (0.4 + rnd()) + (rnd() - 0.5) * 0.3, _n.y * (0.4 + rnd()) + 0.15, _n.z * (0.4 + rnd()) + (rnd() - 0.5) * 0.3,
          tHit, 1.4 + rnd() * 1.8, 3.5, -0.04, 0.015, 0.12 + rnd() * 0.1, 0.52, 0.49, 0.45, 0.55, 0, rnd(), 0, 0.04);
      }
      if (nd < this.decalCap) {
        decA[nd * 4] = hx; decA[nd * 4 + 1] = hy; decA[nd * 4 + 2] = hz; decA[nd * 4 + 3] = tHit;
        decB[nd * 4] = _n.x; decB[nd * 4 + 1] = _n.y; decB[nd * 4 + 2] = _n.z; decB[nd * 4 + 3] = size * 2.2 + 0.004;
        nd++;
      }
    }
    for (const a of Object.values(this.fA)) a.needsUpdate = true;
    this.decA.needsUpdate = this.decB.needsUpdate = true;
    this.decals.geometry.instanceCount = nd;

    // вспышка и огненный шар ≤ 1 м, 30–60 мс; продукты взрыва сквозь трещины (видны только в слоу-мо)
    const fp = this.flashP;
    fp.clear();
    fp.emit(pos.x, pos.y, pos.z, 0, 0, 0, T.sep, 0.035, 0, 0, 0.2, 1.0, 70, 55, 40, 1, 0, 0.5, 0, 0);
    for (let i = 0; i < 70; i++) {
      _r.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
      if (pos.y < 0.3 && _r.y < 0) _r.y = -_r.y * 0.3;
      const s = 20 + rnd() * 30;
      fp.emit(pos.x + _r.x * R0, pos.y + _r.y * R0, pos.z + _r.z * R0, _r.x * s, _r.y * s, _r.z * s,
        T.sep + rnd() * 0.002, 0.03 + rnd() * 0.03, 50, -3, 0.08, 0.35 + rnd() * 0.3, 6, 2.6, 0.8, 1, 0, rnd(), 0, 0.05);
    }
    for (let i = 0; i < 180; i++) {
      _r.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
      const s = 1800 + rnd() * 1400;
      fp.emit(pos.x + _r.x * R0 * 0.8, pos.y + _r.y * R0 * 0.8, pos.z + _r.z * R0 * 0.8, _r.x * s, _r.y * s, _r.z * s,
        T.crack0 + rnd() * (T.sep - T.crack0), 0.0012 + rnd() * 0.001, 3200, 0, 0.006, 0.09, 30, 20, 11, 1, 0, rnd(), 0, 0.02);
    }
    fp.commit();

    // кольцо пыли на полу: ударная волна достигает точки ρ в момент R(t) = √(ρ² + h²)
    const h = pos.y;
    if (h < 1.6) {
      const nR = Math.round(300 * (1 - h / 1.6));
      for (let i = 0; i < nR; i++) {
        const rho = 0.15 + Math.pow(rnd(), 1.6) * 3.2;
        const a = rnd() * Math.PI * 2;
        const ts = shockTime(Math.hypot(rho, h));
        const cx = Math.cos(a), cz = Math.sin(a);
        const push = (5 + rnd() * 5) / (1 + rho * 1.2) / (1 + h * 2);
        du.emit(pos.x + cx * rho, 0.02, pos.z + cz * rho, cx * push, 0.3 + rnd() * 0.9 / (1 + rho), cz * push,
          ts, 2.5 + rnd() * 3, 2.2, 0.25, 0.05, 0.35 + rho * 0.12, 0.47, 0.44, 0.4, 0.42 / (1 + rho * 0.4), 0, rnd(), PF.FLOOR, 0.03);
      }
    }
    st.commit(); sp.commit(); du.commit();

    // тёмно-серый дым с сажей
    const puffs = [];
    for (let i = 0; i < 11; i++) {
      _r.set(rnd() - 0.5, rnd() * 0.8 - 0.2, rnd() - 0.5).normalize();
      if (h < 0.3 && _r.y < 0.1) _r.y = 0.1 + rnd() * 0.3;
      const s = 3 + rnd() * 4;
      puffs.push({ x: pos.x, y: pos.y, z: pos.z, vx: _r.x * s, vy: _r.y * s, vz: _r.z * s, k: 6.5, rise: 0.12 + rnd() * 0.08, r0: 0.12, r1: 0.7 + rnd() * 0.5, tau: 0.45, dens: 3.2, t0: 0.006, life: 9 + rnd() * 5, fin: 0.03 });
    }
    if (h < 1.2) for (let i = 0; i < 4; i++) {
      const a = rnd() * Math.PI * 2, rr = 1 + rnd() * 1.2;
      puffs.push({ x: pos.x, y: 0.05, z: pos.z, vx: Math.cos(a) * rr * 3, vy: 0.2, vz: Math.sin(a) * rr * 3, k: 2.8, rise: 0.04, r0: 0.1, r1: 0.6, tau: 0.9, dens: 0.9, t0: shockTime(rr), life: 7, fin: 0.1 });
    }
    app.smoke.spawn(puffs, _col.setRGB(0.17, 0.16, 0.15), seed, 12);

    // звук и перекрытие
    const cam = app.camera.position;
    const ray = this._ray || (this._ray = new THREE.Raycaster());
    _d.subVectors(pos, cam); const L = _d.length(); _d.multiplyScalar(1 / L);
    ray.set(cam, _d); ray.far = L - 0.05;
    const occ = ray.intersectObjects(app.stage.occluders, false).length ? 1 : 0;
    this.dist = L;
    this.S = clamp(1 / (1 + L / 3), 0, 1) * (occ ? 0.3 : 1);
    app.audio.blast('m67', { pos, seed, occlusion: occ });
    this.update(0, { mode: 'live' });
  }

  update(t, { mode, slow = 1 } = {}) {
    if (!this.detonated) return false;
    const app = this.app, P = app.post.params, fs = app.safety.flashScale;
    const c = this.startPos;
    // корпус: раздутие → трещины со светящимися продуктами → разлёт
    const vis = t < T.sep;
    app.model.group.visible = vis;
    if (this.bodyU) {
      this.bodyU.uSwell.value = 1 + 0.55 * smooth(T.swell0, T.sep, t);
      this.bodyU.uCrack.value = smooth(T.crack0, T.sep, t);
      this.bodyU.uCrackGlow.value = 25 * smooth(T.crack0, T.crack0 + 6e-6, t);
    }
    this.fragU.uT.value = t;
    for (const s of [this.flashP, this.sparks, this.streaks, this.dust]) s.time = t;
    const shutter = mode === 'replay' ? 1 / (60 * slow) : 1 / 90;
    this.streaks.uniforms.uShutter.value = shutter;
    this.sparks.uniforms.uShutter.value = mode === 'replay' ? Math.min(1 / 90, shutter * 4) : 1 / 90;
    this.flashP.uniforms.uShutter.value = shutter;
    this.flashP.uniforms.uGain.value = rk0(mode);
    this.decU.uT.value = t;
    // свет вырывается только через трещины: пик ~мс после разлёта, затем свечение шара
    const fl = t < T.crack0 ? 0 : smooth(T.crack0, T.sep + 4e-6, t) * Math.exp(-Math.max(0, t - T.sep) / 0.0045);
    const fb = t < T.sep ? 0 : Math.exp(-t / 0.035);
    // скоростная камера с короткой выдержкой: вспышка не выжигает кадр
    const rk = mode === 'replay' ? 0.2 : 1;
    this.light.position.set(c.x, c.y + 0.15, c.z);
    this.light.intensity = (9000 * fl + 1500 * fb) * (0.35 + 0.65 * fs) * rk;
    P.flash = (5 * fl + 0.4 * fb) * fs * rk;
    P.flashTint.setRGB(1, 0.86, 0.66);
    P.bloomStrength = 0.05 + 0.3 * fl;
    P.chroma = mode === 'live' && !app.safety.reducedMotion ? 0.5 * Math.exp(-t / 0.06) * this.S * fs : 0;
    // ударная волна: искажение за фронтом и видимая оболочка
    const R = shockRadius(t);
    P.shock.center.copy(c); P.shock.radius = R; P.shock.width = 0.1 + 0.08 * R;
    P.shock.strength = R < 20 ? 0.9 * Math.exp(-R / 3) * (app.safety.reducedMotion ? 0.3 : 1) : 0;
    this.shell.visible = t > 0 && R < 8;
    this.shell.position.copy(c); this.shell.scale.setScalar(Math.max(1e-3, R));
    this.shellU.uStrength.value = (mode === 'replay' ? 0.9 : 0.15) * Math.exp(-R / 2.5);
    // дым подсвечен огнём в первые десятки мс
    _col.setRGB(40, 20, 7).multiplyScalar(fb + 2 * fl);
    app.smoke.update(t, app.stage.sunDir, c, _col);
    return t < this.duration;
  }

  applyEye(t) {
    const P = this.app.post.params;
    P.adapt = 1 - 0.35 * this.S * Math.exp(-t / 1.2) * smooth(0, 0.05, t);
  }

  shakeAt(t, camPos) {
    const d = camPos.distanceTo(this.startPos);
    const ta = d / 343;
    if (t < ta) return 0;
    return 3.2 / (1 + d * 0.9) * Math.exp(-(t - ta) / 0.3);
  }
}
