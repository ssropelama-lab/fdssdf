// GPU-частицы: кольцевой буфер инстансов, траектория — аналитическое решение
// dv/dt = g − k·v в вершинном шейдере. CPU только пишет новые частицы (обычно один раз при взрыве,
// с временем рождения в будущем), поэтому перемотка и слоу-мо бесплатны: меняется лишь uTime.
import * as THREE from 'three';

const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
const IDX = [0, 1, 2, 0, 2, 3];

export const PF = { FLOOR: 1, FIRELIT: 2, SPIN: 4 };

const VERT = /* glsl */`
attribute vec2 corner;
attribute vec4 a0; // p0.xyz, birth
attribute vec4 a1; // v0.xyz, life
attribute vec4 a2; // drag, gravity (вниз), size0, size1
attribute vec4 a3; // rgb, alpha/яркость
attribute vec4 a4; // stretch, seed, flags, fade-in доля
uniform float uTime, uShutter;
varying vec2 vUv;
varying vec4 vCol;
varying float vDepth, vT, vSeed;
varying vec3 vWorld;

void kin(float t, float k, float g, vec3 p0, vec3 v0, out vec3 p, out vec3 v) {
  vec3 gv = vec3(0.0, -g, 0.0);
  if (k < 1e-3) { p = p0 + v0 * t + 0.5 * gv * t * t; v = v0 + gv * t; return; }
  float e = exp(-k * t);
  float f = (1.0 - e) / k;
  p = p0 + v0 * f + gv * (t - f) / k;
  v = v0 * e + gv * f;
}

void main() {
  float age = uTime - a0.w;
  float life = a1.w;
  vUv = corner * 0.5 + 0.5;
  if (age < 0.0 || age > life || life <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec4(0.0); return; }
  float tn = age / life;
  vT = tn; vSeed = a4.y;
  vec3 p, v;
  kin(age, a2.x, a2.y, a0.xyz, a1.xyz, p, v);
  float flags = a4.z;
  if (mod(flags, 2.0) >= 1.0 && p.y < 0.004) { p.y = 0.004; v.y = 0.0; }
  #ifdef SMOKE
    // лёгкая турбулентность
    p += vec3(sin(age * 1.3 + a4.y * 40.0), 0.0, cos(age * 1.1 + a4.y * 31.0)) * 0.05 * tn * a2.w;
  #endif
  float size = mix(a2.z, a2.w, 1.0 - (1.0 - tn) * (1.0 - tn));
  vWorld = p;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 vv = mat3(modelViewMatrix) * v;
  float l = length(vv.xy);
  vec2 dir = l > 1e-5 ? vv.xy / l : vec2(1.0, 0.0);
  #ifdef SMOKE
    float ang = a4.y * 6.2831 + age * (a4.y - 0.5) * 0.6;
    dir = vec2(cos(ang), sin(ang)); l = 0.0;
  #endif
  vec2 perp = vec2(-dir.y, dir.x);
  float streak = l * uShutter * a4.x;
  float len = size + streak;
  mv.xy += dir * (corner.x * len * 0.5 - streak * 0.5) + perp * corner.y * size * 0.5;
  vDepth = -mv.z;
  float fin = a4.w > 0.0 ? clamp(tn / a4.w, 0.0, 1.0) : 1.0;
  vCol = vec4(a3.rgb, a3.a * fin);
  // толщина штриха < пикселя — компенсируем яркостью, чтобы тонкие искры не мерцали
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
uniform sampler2D tDepth;
uniform sampler2D tAtlas;
uniform float uCamNear, uCamFar, uSoft, uTime, uGain;
uniform vec2 uFxRes;
uniform vec3 uAmbient, uGlowPos, uGlowCol;
varying vec2 vUv;
varying vec4 vCol;
varying float vDepth, vT, vSeed;
varying vec3 vWorld;

float linDepth(float d) { return uCamNear * uCamFar / (uCamFar - d * (uCamFar - uCamNear)); }
float h12(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn2(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h12(i), h12(i + vec2(1.0, 0.0)), f.x), mix(h12(i + vec2(0.0, 1.0)), h12(i + 1.0), f.x), f.y);
}

void main() {
  if (vCol.a <= 0.0) discard;
  vec2 suv = gl_FragCoord.xy / uFxRes;
  float sceneZ = linDepth(texture2D(tDepth, suv).r);
  float dz = sceneZ - vDepth;
  if (dz < 0.0) discard;
  float soft = clamp(dz / uSoft, 0.0, 1.0);
  vec2 q = vUv * 2.0 - 1.0;
  #if defined(SPARK)
    float r2 = dot(q, q);
    float m = exp(-r2 * 3.5) * (1.0 - smoothstep(0.7, 1.0, r2));
    // остывание: бело-жёлтый → оранжевый → тёмно-красный
    vec3 hot = vCol.rgb;
    vec3 c = mix(hot, hot * vec3(1.0, 0.35, 0.08) * 0.35, smoothstep(0.0, 0.8, vT));
    float fade = (1.0 - vT) * (1.0 - vT);
    gl_FragColor = vec4(c * m * fade * vCol.a * soft * uGain, 0.0);
  #elif defined(GLOW)
    float r = length(q);
    float n = 0.45 + 0.55 * (vn2(q * 2.5 + vSeed * 17.0) * 0.65 + vn2(q * 5.0 - vSeed * 9.0 + vT * 3.0) * 0.35);
    float m = exp(-r * r * 4.0) * n * (1.0 - smoothstep(0.8, 1.0, r));
    float fade = 1.0 - smoothstep(0.35, 1.0, vT);
    vec3 c = mix(vCol.rgb, vCol.rgb * vec3(1.0, 0.45, 0.15) * 0.3, smoothstep(0.1, 0.9, vT));
    gl_FragColor = vec4(c * m * fade * vCol.a * soft * uGain, 0.0);
  #else
    // дым: атлас 4×4 кадров с плавной сменой
    float fr = vT * 15.0;
    float f0 = floor(fr), fk = fr - f0;
    vec2 uv = vUv * 0.25;
    vec2 o0 = vec2(mod(f0, 4.0), floor(f0 / 4.0)) * 0.25;
    float f1 = min(f0 + 1.0, 15.0);
    vec2 o1 = vec2(mod(f1, 4.0), floor(f1 / 4.0)) * 0.25;
    vec4 s = mix(texture2D(tAtlas, o0 + uv), texture2D(tAtlas, o1 + uv), fk);
    float a = s.a * vCol.a * soft * (1.0 - smoothstep(0.55, 1.0, vT));
    if (a < 0.002) discard;
    float lit = mix(0.55, 1.15, vUv.y) * (0.75 + 0.25 * s.r);
    vec3 c = vCol.rgb * uAmbient * lit;
    vec3 dg = vWorld - uGlowPos;
    c += vCol.rgb * uGlowCol / (1.0 + dot(dg, dg) * 6.0);
    gl_FragColor = vec4(c * a, a);
  #endif
}
`;

export class GpuParticles {
  constructor({ capacity = 4096, kind = 'spark', fxUniforms, atlas = null, soft = 0.05, name = 'particles' }) {
    this.capacity = capacity;
    this.head = 0; this.count = 0;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.BufferAttribute(QUAD, 2));
    g.setIndex(IDX);
    this.arrays = [];
    this.attrs = [];
    for (let i = 0; i < 5; i++) {
      const arr = new Float32Array(capacity * 4);
      const a = new THREE.InstancedBufferAttribute(arr, 4).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('a' + i, a);
      this.arrays.push(arr); this.attrs.push(a);
    }
    g.instanceCount = capacity;
    this.geometry = g;
    this.uniforms = {
      uTime: { value: 0 }, uShutter: { value: 1 / 120 }, uSoft: { value: soft }, uGain: { value: 1 },
      tDepth: fxUniforms.tDepth, uCamNear: fxUniforms.uCamNear, uCamFar: fxUniforms.uCamFar, uFxRes: fxUniforms.uFxRes,
      tAtlas: { value: atlas }, uAmbient: { value: new THREE.Color(0.5, 0.5, 0.52) },
      uGlowPos: { value: new THREE.Vector3() }, uGlowCol: { value: new THREE.Color(0, 0, 0) },
    };
    const defines = {}; defines[kind === 'smoke' ? 'SMOKE' : kind === 'glow' ? 'GLOW' : 'SPARK'] = '';
    const smoke = kind === 'smoke';
    this.material = new THREE.ShaderMaterial({
      name, defines, uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: smoke ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: smoke ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = name;
    this.dirtyLo = Infinity; this.dirtyHi = -1;
    this.clear();
  }
  set time(t) { this.uniforms.uTime.value = t; }
  get time() { return this.uniforms.uTime.value; }

  clear() {
    for (const a of this.arrays) a.fill(0);
    this.head = 0; this.count = 0;
    this.dirtyLo = 0; this.dirtyHi = this.capacity - 1;
    this.maxAlive = 0;
  }

  // Одна частица. Все параметры — числа, чтобы не аллоцировать.
  emit(px, py, pz, vx, vy, vz, birth, life, drag, grav, s0, s1, r, g, b, a, stretch = 0, seed = Math.random(), flags = 0, fadeIn = 0) {
    const i = this.head, o = i * 4, A = this.arrays;
    A[0][o] = px; A[0][o + 1] = py; A[0][o + 2] = pz; A[0][o + 3] = birth;
    A[1][o] = vx; A[1][o + 1] = vy; A[1][o + 2] = vz; A[1][o + 3] = life;
    A[2][o] = drag; A[2][o + 1] = grav; A[2][o + 2] = s0; A[2][o + 3] = s1;
    A[3][o] = r; A[3][o + 1] = g; A[3][o + 2] = b; A[3][o + 3] = a;
    A[4][o] = stretch; A[4][o + 1] = seed; A[4][o + 2] = flags; A[4][o + 3] = fadeIn;
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
    this.head = (i + 1) % this.capacity;
    if (this.head === 0) { this.dirtyLo = 0; this.dirtyHi = this.capacity - 1; }
    this.count = Math.min(this.capacity, this.count + 1);
  }

  commit() {
    if (this.dirtyHi < this.dirtyLo) return;
    const start = this.dirtyLo * 4, cnt = (this.dirtyHi - this.dirtyLo + 1) * 4;
    for (const a of this.attrs) { a.clearUpdateRanges(); a.addUpdateRange(start, cnt); a.needsUpdate = true; }
    this.dirtyLo = Infinity; this.dirtyHi = -1;
    this.geometry.instanceCount = this.count;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// Атлас дыма 4×4: клубы, которые со временем рыхлеют. Генерация один раз при старте.
export function makeSmokeAtlas(size = 512) {
  const cell = size / 4;
  const data = new Uint8Array(size * size * 4);
  const perm = new Uint8Array(512);
  let s = 1337;
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y, z) => { const u = (h & 15) < 8 ? x : y, v = (h & 15) < 4 ? y : (h & 15) === 12 || (h & 15) === 14 ? x : z; return ((h & 1) ? -u : u) + ((h & 2) ? -v : v); };
  const noise = (x, y, z) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z, B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
    const l = (a, b, t) => a + t * (b - a);
    return l(l(l(grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z), u), l(grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z), u), v),
      l(l(grad(perm[AA + 1], x, y, z - 1), grad(perm[BA + 1], x - 1, y, z - 1), u), l(grad(perm[AB + 1], x, y - 1, z - 1), grad(perm[BB + 1], x - 1, y - 1, z - 1), u), v), w);
  };
  for (let f = 0; f < 16; f++) {
    const ox = (f % 4) * cell, oy = Math.floor(f / 4) * cell;
    const tz = f * 0.23, spread = 0.55 + f * 0.022;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const u = (x + 0.5) / cell * 2 - 1, v = (y + 0.5) / cell * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      let n = 0, amp = 0.5, fr = 2.2;
      for (let o = 0; o < 4; o++) { n += amp * noise(u * fr + 7.1, v * fr + 3.3, tz + o * 1.7); amp *= 0.5; fr *= 2.03; }
      const falloff = Math.max(0, 1 - r / spread);
      let a = falloff * falloff * (0.65 + 1.1 * n) - f * 0.004;
      a = Math.max(0, Math.min(1, a * 1.4));
      const lum = Math.max(0, Math.min(1, 0.6 + n * 0.9));
      const o = ((oy + y) * size + ox + x) * 4;
      data[o] = lum * 255; data[o + 1] = lum * 255; data[o + 2] = lum * 255; data[o + 3] = a * 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
