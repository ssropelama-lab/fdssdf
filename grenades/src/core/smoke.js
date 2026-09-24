// Дым. Описание — набор «клубов» (центр/радиус/плотность как функции времени).
// high/med: объёмный raymarch по 3D-шуму в цели ½ или ¼ разрешения с временным джиттером;
// low: те же клубы рисуются инстансированными спрайтами из атласа (один вызов отрисовки).
import * as THREE from 'three';
import { GpuParticles, PF } from './particles.js';
import { mulberry32 } from './rng.js';

const MAXP = 16;

function makeNoise3D(n = 32) {
  const rnd = mulberry32(99);
  const base = new Float32Array(n * n * n);
  for (let i = 0; i < base.length; i++) base[i] = rnd();
  const at = (x, y, z) => base[((z & (n - 1)) * n + (y & (n - 1))) * n + (x & (n - 1))];
  const smooth = (x, y, z, s) => {
    // значение шума с периодом n/s (тайлится)
    const fx = x / s, fy = y / s, fz = z / s;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty), w = tz * tz * (3 - 2 * tz);
    const m = n / s;
    const g = (a, b, c) => at(((ix + a) % m) * s * 7 + 3, ((iy + b) % m) * s * 13 + 5, ((iz + c) % m) * s * 5 + 11);
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(g(0, 0, 0), g(1, 0, 0), u), l(g(0, 1, 0), g(1, 1, 0), u), v), l(l(g(0, 0, 1), g(1, 0, 1), u), l(g(0, 1, 1), g(1, 1, 1), u), v), w);
  };
  const data = new Uint8Array(n * n * n);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = 0.55 * smooth(x, y, z, 8) + 0.3 * smooth(x, y, z, 4) + 0.15 * smooth(x, y, z, 2);
    data[(z * n + y) * n + x] = Math.max(0, Math.min(255, v * 255));
  }
  const tex = new THREE.Data3DTexture(data, n, n, n);
  tex.format = THREE.RedFormat;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

const VOL_FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform sampler2D tDepth;
uniform sampler3D tNoise;
uniform mat4 uInvProj, uCamWorld;
uniform float uCamNear, uCamFar, uTime, uFrame, uSigma;
uniform int uSteps, uCount;
uniform vec4 uPuffA[${MAXP}];   // центр, радиус
uniform float uPuffD[${MAXP}];  // плотность
uniform vec4 uBound;            // общая сфера
uniform vec3 uAlbedo, uAmbient, uSunDir, uSunCol, uGlowPos, uGlowCol, uWind;
varying vec2 vUv;

float linDepth(float d) { return uCamNear * uCamFar / (uCamFar - d * (uCamFar - uCamNear)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

float density(vec3 p) {
  float d = 0.0;
  for (int i = 0; i < ${MAXP}; i++) {
    if (i >= uCount) break;
    vec3 q = p - uPuffA[i].xyz;
    float r = uPuffA[i].w;
    float g = 1.0 - dot(q, q) / (r * r);
    if (g > 0.0) d += uPuffD[i] * g * g;
  }
  if (d <= 0.0) return 0.0;
  vec3 np = p * 1.7 - uWind * uTime;
  float n = texture(tNoise, np).r * 0.65 + texture(tNoise, np * 2.9 + 0.37).r * 0.35;
  return max(0.0, d * (n * 1.9 - 0.45));
}

void main() {
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vdir = normalize(vp.xyz / vp.w);
  vec3 ro = uCamWorld[3].xyz;
  vec3 rd = normalize(mat3(uCamWorld) * vdir);
  vec3 oc = ro - uBound.xyz;
  float b = dot(oc, rd), c = dot(oc, oc) - uBound.w * uBound.w;
  float h = b * b - c;
  if (h <= 0.0) { gl_FragColor = vec4(0.0); return; }
  h = sqrt(h);
  float t0 = max(0.0, -b - h), t1 = -b + h;
  float sceneT = linDepth(texture2D(tDepth, vUv).r) / max(1e-4, -vdir.z);
  t1 = min(t1, sceneT);
  if (t1 <= t0) { gl_FragColor = vec4(0.0); return; }
  float ds = (t1 - t0) / float(uSteps);
  float t = t0 + ds * ign(gl_FragCoord.xy + uFrame * 5.588);
  float T = 1.0;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= uSteps || T < 0.02) break;
    vec3 p = ro + rd * t;
    float d = density(p);
    if (d > 0.001) {
      float dl = density(p + uSunDir * 0.18);
      float sh = exp(-dl * uSigma * 0.25);
      float up = clamp(0.6 + (p.y - uBound.y) / max(0.1, uBound.w), 0.3, 1.3);
      vec3 g = p - uGlowPos;
      vec3 L = uAmbient * up + uSunCol * sh + uGlowCol / (1.0 + dot(g, g) * 6.0);
      float a = 1.0 - exp(-d * uSigma * ds);
      col += T * a * uAlbedo * L;
      T *= 1.0 - a;
    }
    t += ds;
  }
  gl_FragColor = vec4(col, 1.0 - T);
}
`;

export class SmokeSystem {
  constructor({ fxUniforms, atlas, capacity = 4096 }) {
    this.puffs = [];
    this.color = new THREE.Color(0.5, 0.5, 0.5);
    this.sprites = new GpuParticles({ capacity, kind: 'smoke', fxUniforms, atlas, soft: 0.12, name: 'smokeSprites' });
    this.noise = makeNoise3D(32);
    this.uniforms = {
      tDepth: { value: null }, tNoise: { value: this.noise },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uCamNear: fxUniforms.uCamNear, uCamFar: fxUniforms.uCamFar,
      uTime: { value: 0 }, uFrame: { value: 0 }, uSigma: { value: 18 }, uSteps: { value: 24 }, uCount: { value: 0 },
      uPuffA: { value: Array.from({ length: MAXP }, () => new THREE.Vector4()) },
      uPuffD: { value: new Float32Array(MAXP) },
      uBound: { value: new THREE.Vector4(0, -100, 0, 0.01) },
      uAlbedo: { value: new THREE.Color(0.5, 0.5, 0.5) }, uAmbient: { value: new THREE.Color(0.35, 0.37, 0.4) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() }, uSunCol: { value: new THREE.Color(0.9, 0.85, 0.8) },
      uGlowPos: { value: new THREE.Vector3() }, uGlowCol: { value: new THREE.Color(0, 0, 0) },
      uWind: { value: new THREE.Vector3(0.02, 0.06, 0.01) },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'volumeSmoke', uniforms: this.uniforms, fragmentShader: VOL_FRAG, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.qscene = new THREE.Scene(); this.qscene.add(this.quad);
    this.qcam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.mode = 'volume';
    this.active = false;
    this.frame = 0;
    const self = this;
    // хук для post.volume
    this.volumeHook = {
      enabled: false,
      render(renderer, camera, depthTexture, target) { self.renderVolume(renderer, camera, depthTexture, target); },
    };
    this._c = new THREE.Vector3();
  }

  setQuality(q) {
    this.mode = q.volumetric ? 'volume' : 'sprites';
    this.uniforms.uSteps.value = q.volSteps || 24;
  }

  // puffs: [{x,y,z, vx,vy,vz, k, rise, r0, r1, tau, dens, t0, life, fin}]
  spawn(puffs, albedo, seed, spritesPerPuff = 10) {
    this.puffs = puffs.slice(0, MAXP);
    this.color.copy(albedo);
    this.uniforms.uAlbedo.value.copy(albedo);
    this.sprites.clear();
    const rnd = mulberry32(seed ^ 0x5a5a);
    // спрайтовый вариант тех же клубов
    for (const p of puffs) {
      for (let i = 0; i < spritesPerPuff; i++) {
        const a = rnd() * Math.PI * 2, z = rnd() * 2 - 1, s = Math.sqrt(1 - z * z), rr = p.r0 * Math.cbrt(rnd());
        const ox = Math.cos(a) * s, oy = z, oz = Math.sin(a) * s;
        const spread = (p.r1 - p.r0) / Math.max(0.05, p.tau) * 0.6;
        this.sprites.emit(p.x + ox * rr, p.y + oy * rr, p.z + oz * rr,
          p.vx + ox * spread, p.vy + oy * spread * 0.6, p.vz + oz * spread,
          p.t0 + rnd() * 0.05, p.life * (0.7 + rnd() * 0.5), p.k + 1 / Math.max(0.1, p.tau), -p.rise,
          p.r0 * 1.6, p.r1 * (1.1 + rnd() * 0.5),
          albedo.r, albedo.g, albedo.b, Math.min(1, p.dens * 0.9), 0, rnd(), PF.FIRELIT, p.fin ?? 0.08);
      }
    }
    this.sprites.commit();
    this.active = puffs.length > 0;
  }

  clear() {
    this.puffs = []; this.active = false; this.sprites.clear(); this.sprites.commit();
    this.uniforms.uCount.value = 0; this.volumeHook.enabled = false;
  }

  // Состояние клуба в момент t — чистая функция времени
  evalPuff(p, t, out4) {
    const a = t - p.t0;
    if (a <= 0) return 0;
    const e = Math.exp(-p.k * a), f = (1 - e) / p.k;
    const rise = p.rise * Math.max(0, a - 0.4 * (1 - Math.exp(-a / 0.4)));
    out4.set(p.x + p.vx * f, p.y + p.vy * f + rise, p.z + p.vz * f, p.r0 + (p.r1 - p.r0) * (1 - Math.exp(-a / p.tau)));
    const fin = Math.min(1, a / Math.max(1e-4, p.fin ?? 0.08));
    return p.dens * fin * Math.exp(-a / p.life);
  }

  update(t, sunDir, glowPos, glowCol) {
    this.sprites.time = t;
    this.sprites.uniforms.uGlowPos.value.copy(glowPos);
    this.sprites.uniforms.uGlowCol.value.copy(glowCol);
    const U = this.uniforms;
    U.uTime.value = t;
    U.uGlowPos.value.copy(glowPos); U.uGlowCol.value.copy(glowCol);
    if (sunDir) U.uSunDir.value.copy(sunDir);
    let n = 0, maxD = 0;
    const c = this._c.set(0, 0, 0);
    let wsum = 0;
    for (let i = 0; i < this.puffs.length; i++) {
      const v4 = U.uPuffA.value[n];
      const d = this.evalPuff(this.puffs[i], t, v4);
      if (d < 0.004) continue;
      U.uPuffD.value[n] = d; maxD = Math.max(maxD, d);
      c.x += v4.x * v4.w; c.y += v4.y * v4.w; c.z += v4.z * v4.w; wsum += v4.w;
      n++;
    }
    U.uCount.value = n;
    if (n > 0) {
      c.multiplyScalar(1 / wsum);
      let R = 0;
      for (let i = 0; i < n; i++) { const v4 = U.uPuffA.value[i]; R = Math.max(R, Math.hypot(v4.x - c.x, v4.y - c.y, v4.z - c.z) + v4.w); }
      U.uBound.value.set(c.x, c.y, c.z, R);
    }
    const on = n > 0;
    this.volumeHook.enabled = on && this.mode === 'volume';
    this.sprites.mesh.visible = this.mode === 'sprites';
    return on;
  }

  renderVolume(renderer, camera, depthTexture, target) {
    const U = this.uniforms;
    U.tDepth.value = depthTexture;
    U.uInvProj.value.copy(camera.projectionMatrixInverse);
    U.uCamWorld.value.copy(camera.matrixWorld);
    U.uFrame.value = (this.frame = (this.frame + 1) % 64);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.qscene, this.qcam);
  }

  // Для прогрева: включить все ветки на один кадр
  warmState(center) {
    const U = this.uniforms;
    U.uCount.value = 1; U.uPuffA.value[0].set(center.x, center.y, center.z, 0.3); U.uPuffD.value[0] = 1;
    U.uBound.value.set(center.x, center.y, center.z, 0.3);
    this.volumeHook.enabled = true;
  }
}
