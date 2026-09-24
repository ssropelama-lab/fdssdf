// Детерминированные случайные числа: у каждого взрыва свой seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Целочисленный хэш, побитово совпадает с hash3u в GLSL (m67/blast.js), чтобы
// трещины в шейдере корпуса и осколки на CPU строились по одним и тем же точкам.
export function hash3u(x, y, z) {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export const GLSL_HASH = /* glsl */`
uint hash3u(ivec3 c) {
  uint h = (uint(c.x) * 0x8da6b343u) ^ (uint(c.y) * 0xd8163841u) ^ (uint(c.z) * 0xcb1ab31fu);
  h = (h ^ (h >> 16)) * 0x7feb352du;
  h = (h ^ (h >> 15)) * 0x846ca68bu;
  return h ^ (h >> 16);
}
vec3 hash3f(ivec3 c) {
  uint a = hash3u(c);
  uint b = a * 0x9e3779b9u + 0x7f4a7c15u; b = (b ^ (b >> 15)) * 0x2c1b3c6du;
  uint d = b * 0x9e3779b9u + 0x7f4a7c15u; d = (d ^ (d >> 15)) * 0x297a2d39u;
  return vec3(float(a >> 8), float(b >> 8), float(d >> 8)) / 16777216.0;
}
`;

export function hash3f(x, y, z, out) {
  const a = hash3u(x, y, z);
  let b = (Math.imul(a, 0x9e3779b9) + 0x7f4a7c15) >>> 0; b = Math.imul(b ^ (b >>> 15), 0x2c1b3c6d) >>> 0;
  let d = (Math.imul(b, 0x9e3779b9) + 0x7f4a7c15) >>> 0; d = Math.imul(d ^ (d >>> 15), 0x297a2d39) >>> 0;
  out[0] = (a >>> 8) / 16777216; out[1] = (b >>> 8) / 16777216; out[2] = (d >>> 8) / 16777216;
  return out;
}

export const randRange = (rnd, a, b) => a + (b - a) * rnd();
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const newSeed = () => (Math.random() * 0xffffffff) >>> 0;

// Кусочно-линейная интерполяция в логарифмах: keys = [[t, value], ...] по возрастанию t
export function logInterp(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      const k = Math.log(t / t0) / Math.log(t1 / t0);
      return Math.exp(Math.log(v0) + (Math.log(v1) - Math.log(v0)) * k);
    }
  }
  return keys[keys.length - 1][1];
}
