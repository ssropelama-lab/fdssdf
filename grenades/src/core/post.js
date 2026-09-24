// HDR-постобработка без EffectComposer: сцена → HDR RT, fx-слой, объёмный дым, bloom (dual Kawase),
// грязь на объективе, ударная волна/марево, хром. аберрация, вспышка, остаточное изображение,
// тонмаппинг AgX/ACES, sRGB, виньетка, зерно, дизеринг, прогрессивное накопление.
import * as THREE from 'three';

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Общий композит scene + fx (премультиплированный) + объём
const COMP = /* glsl */`
uniform sampler2D tScene;
uniform sampler2D tFx;
uniform sampler2D tVol;
uniform float uVolOn;
uniform vec2 uVolTexel;
vec3 compBase(vec2 uv) {
  // HalfFloat переполняется в Inf у поверхностей вплотную к вспышке; Inf·0 дал бы NaN (чёрные пятна)
  vec3 c = min(texture2D(tScene, uv).rgb, vec3(6.0e4));
  vec4 f = min(texture2D(tFx, uv), vec4(6.0e4, 6.0e4, 6.0e4, 1.0));
  return c * (1.0 - f.a) + f.rgb;
}
vec4 volBlur(vec2 uv) {
  vec2 o = uVolTexel * 0.75;
  return texture2D(tVol, uv) * 0.4 + 0.15 * (
    texture2D(tVol, uv + vec2(o.x, o.y)) + texture2D(tVol, uv + vec2(-o.x, o.y)) +
    texture2D(tVol, uv + vec2(o.x, -o.y)) + texture2D(tVol, uv + vec2(-o.x, -o.y)));
}
vec3 comp(vec2 uv) {
  vec3 c = compBase(uv);
  if (uVolOn > 0.5) { vec4 v = volBlur(uv); c = c * (1.0 - v.a) + v.rgb; }
  return c;
}
vec3 compFast(vec2 uv) {
  vec3 c = compBase(uv);
  if (uVolOn > 0.5) { vec4 v = texture2D(tVol, uv); c = c * (1.0 - v.a) + v.rgb; }
  return c;
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

const PREFILTER_FRAG = /* glsl */`
${COMP}
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  // Karis: веса 1/(1+L) гасят одиночные «светлячки»
  vec3 a = compFast(vUv);
  vec3 b = compFast(vUv + vec2(-uTexel.x, -uTexel.y));
  vec3 c = compFast(vUv + vec2( uTexel.x, -uTexel.y));
  vec3 d = compFast(vUv + vec2(-uTexel.x,  uTexel.y));
  vec3 e = compFast(vUv + vec2( uTexel.x,  uTexel.y));
  float wa = 4.0 / (1.0 + luma(a)), wb = 1.0 / (1.0 + luma(b)), wc = 1.0 / (1.0 + luma(c));
  float wd = 1.0 / (1.0 + luma(d)), we = 1.0 / (1.0 + luma(e));
  vec3 col = (a * wa + b * wb + c * wc + d * wd + e * we) / (wa + wb + wc + wd + we);
  col = min(col, vec3(6.0e4));
  float br = max(col.r, max(col.g, col.b));
  float knee = uThreshold * 0.5 + 1e-4;
  float rq = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  rq = rq * rq / (4.0 * knee);
  col *= max(rq, br - uThreshold) / max(br, 1e-4);
  gl_FragColor = vec4(col, 1.0);
}
`;

const DOWN_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
  s += texture2D(tSrc, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;
  s += texture2D(tSrc, vUv + vec2( uTexel.x, -uTexel.y)).rgb;
  s += texture2D(tSrc, vUv + vec2(-uTexel.x,  uTexel.y)).rgb;
  s += texture2D(tSrc, vUv + vec2( uTexel.x,  uTexel.y)).rgb;
  gl_FragColor = vec4(s * 0.125, 1.0);
}
`;

const UP_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform sampler2D tCur;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 s = texture2D(tSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(0.0, h.y * 2.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  gl_FragColor = vec4(s / 12.0 + texture2D(tCur, vUv).rgb, 1.0);
}
`;

const CAPTURE_FRAG = /* glsl */`
${COMP}
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec3 s = vec3(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++)
    s += compFast(vUv + (vec2(float(i), float(j)) - 1.5) * uStep);
  gl_FragColor = vec4(min(s / 16.0, vec3(6.0e4)), 1.0);
}
`;

const COPY_FRAG = /* glsl */`
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv); }
`;

const FINAL_FRAG = /* glsl */`
${COMP}
uniform sampler2D tBloom;
uniform sampler2D tDirt;
uniform sampler2D tAfter;
uniform float uBloom;
uniform float uDirt;
uniform vec3 uFlash;
uniform float uChroma;
uniform vec4 uShock;      // xy центр (uv), z радиус, w ширина (в долях высоты экрана)
uniform float uShockStr;
uniform vec4 uHaze;       // xy центр, z радиус, w сила
uniform vec3 uAfter;      // xy смещение, z сила
uniform float uAfterLod;
uniform float uExposure;
uniform int uToneMapper;  // 0 AgX, 1 ACES
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uAspect;
uniform vec2 uRes;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}

// ACES (Narkowicz/Hill), как в three r166
vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesTone(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(
    vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color = ACESInputMat * (color / 0.6);
  color = rrtOdtFit(color);
  return clamp(ACESOutputMat * color, 0.0, 1.0);
}
// AgX (iolite minimal), как в three r166
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x; vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agxTone(vec3 color) {
  const mat3 SRGB_TO_2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 R2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 Inset = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 Outset = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393, maxEv = 4.026069;
  color = Inset * (SRGB_TO_2020 * color);
  color = clamp((log2(max(color, 1e-10)) - minEv) / (maxEv - minEv), 0.0, 1.0);
  color = Outset * agxContrast(color);
  color = pow(max(vec3(0.0), color), vec3(2.2));
  return clamp(R2020_TO_SRGB * color, 0.0, 1.0);
}
vec3 srgbEncode(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;
  vec2 asp = vec2(uAspect, 1.0);

  if (uShockStr > 0.0) {
    vec2 d = (uv - uShock.xy) * asp;
    float dist = length(d);
    float x = (dist - uShock.z) / max(uShock.w, 1e-4);
    // производная гауссова профиля: тонкое кольцо-линза
    float prof = x * exp(-x * x * 2.0);
    uv -= (d / max(dist, 1e-5)) / asp * prof * uShockStr * 0.035;
  }
  if (uHaze.w > 0.0) {
    vec2 d = (uv - uHaze.xy) * asp / max(uHaze.z, 1e-4);
    // столб над центром: эллипс, вытянутый вверх
    float m = exp(-d.x * d.x * 0.35) * smoothstep(-1.0, 1.0, d.y) * exp(-max(d.y, 0.0) * 0.18);
    if (m > 0.002) {
      vec2 q = d * vec2(1.3, 0.7) - vec2(0.0, uTime * 2.2);
      vec2 n = vec2(vnoise(q * 2.0), vnoise(q * 2.0 + 17.3)) + 0.5 * vec2(vnoise(q * 4.7 + 3.1), vnoise(q * 4.7 + 9.7));
      uv += (n - 0.75) * uHaze.w * 0.008 * m;
    }
  }

  vec3 col;
  if (uChroma > 0.0) {
    vec2 dir = (uv - 0.5) * uChroma * 0.014;
    col = vec3(comp(uv - dir).r, comp(uv).g, comp(uv + dir).b);
  } else {
    col = comp(uv);
  }

  vec3 bloom = texture2D(tBloom, uv).rgb;
  col += bloom * uBloom;
  if (uDirt > 0.0) col += texture2D(tDirt, vUv).rgb * (bloom * uBloom * 6.0 + uFlash * 0.03) * uDirt;
  col += uFlash;

  if (uAfter.z > 0.0) {
    vec2 au = vUv + uAfter.xy;
    vec2 ao = 1.5 / vec2(textureSize(tAfter, 0));
    vec3 a = 0.25 * (textureLod(tAfter, au + vec2(ao.x, ao.y), 1.0).rgb + textureLod(tAfter, au - vec2(ao.x, ao.y), 1.0).rgb +
                     textureLod(tAfter, au + vec2(ao.x, -ao.y), 1.0).rgb + textureLod(tAfter, au + vec2(-ao.x, ao.y), 1.0).rgb);
    float L = luma(a);
    // яркость относительно средней по снимку: призрак остаётся от самых ярких мест
    float avgL = luma(textureLod(tAfter, vec2(0.5), uAfterLod).rgb);
    float rl = L / max(avgL * 1.5, 0.5);
    float m = clamp((rl - 1.0) / (rl + 1.0), 0.0, 1.0) * uAfter.z;
    vec3 hue = mix(vec3(1.0), a / max(L, 1e-4), 0.25);
    // негатив: ярко → тёмное пятно, в центре пурпур, по краю зелень
    vec3 tint = mix(vec3(0.45, 1.0, 0.55), vec3(0.95, 0.4, 1.0), smoothstep(0.2, 0.8, m / max(uAfter.z, 1e-4)));
    tint = clamp(tint * (1.6 - hue * 0.6), 0.0, 1.2);
    col = col * mix(vec3(1.0), tint * 0.2, clamp(m, 0.0, 1.0)) + tint * m * 0.03;
  }

  col *= uExposure;
  col = uToneMapper == 1 ? acesTone(col) : agxTone(col);
  col = srgbEncode(col);

  vec2 vd = (vUv - 0.5) * vec2(uAspect, 1.0) / sqrt(uAspect * uAspect + 1.0) * 2.0;
  col *= 1.0 - uVignette * smoothstep(0.25, 1.1, dot(vd, vd));

  vec2 px = gl_FragCoord.xy;
  if (uGrain > 0.0) {
    float g = hash12(px + fract(uTime * 7.31) * 1000.0) - 0.5;
    float l = luma(col);
    col += g * uGrain * (0.35 + 4.0 * l * (1.0 - l));
  }
  // треугольный дизеринг ±1 LSB против бандинга
  float t = hash12(px + 0.37) + hash12(px.yx + 71.9) - 1.0;
  col += t / 255.0;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}

// Процедурная грязь на объективе: пятна, крапинки, шестиугольные «боке»
function makeDirtTexture(size = 512) {
  const cv = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(size, size);
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = 'lighter';
  const blob = (x, y, r, a, tint) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${tint[0]},${tint[1]},${tint[2]},${a})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  for (let i = 0; i < 26; i++) {   // крупные размазанные пятна
    const w = 200 + rnd() * 55;
    blob(rnd() * size, rnd() * size, size * (0.06 + rnd() * 0.18), 0.05 + rnd() * 0.1, [w, w, 200 + rnd() * 55]);
  }
  for (let i = 0; i < 7; i++) {    // мазки пальцем
    g.save(); g.translate(rnd() * size, rnd() * size); g.rotate(rnd() * Math.PI); g.scale(1, 0.25 + rnd() * 0.3);
    blob(0, 0, size * (0.08 + rnd() * 0.1), 0.08 + rnd() * 0.08, [230, 235, 255]); g.restore();
  }
  for (let i = 0; i < 14; i++) {   // шестиугольные боке
    const x = rnd() * size, y = rnd() * size, r = size * (0.015 + rnd() * 0.04), a = 0.12 + rnd() * 0.18;
    const rot = rnd() * 0.5;
    g.beginPath();
    for (let k = 0; k < 6; k++) { const an = rot + k * Math.PI / 3; g[k ? 'lineTo' : 'moveTo'](x + Math.cos(an) * r, y + Math.sin(an) * r); }
    g.closePath();
    g.fillStyle = `rgba(${200 + rnd() * 55 | 0},${210 + rnd() * 45 | 0},255,${a * 0.6})`; g.fill();
    g.lineWidth = r * 0.12; g.strokeStyle = `rgba(255,255,255,${a})`; g.stroke();
  }
  for (let i = 0; i < 420; i++) {  // пылинки
    const r = 0.6 + rnd() * rnd() * 3.5;
    blob(rnd() * size, rnd() * size, r * 2, 0.25 + rnd() * 0.6, [255, 255, 255]);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  return tex;
}

const QDEF = { name: 'med', msaa: 0, bloomLevels: 5, fxScale: 0.5, volScale: 0.25, dirt: true, grain: true };

export class PostPipeline {
  constructor(renderer, quality) {
    this.renderer = renderer;
    // Всё в линейном RT; к экрану пишем сами с ручным sRGB. Linear и для экрана, чтобы
    // финальный шейдер не имел двух программ (экран/RT) и не кодировался дважды.
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    // info копится за весь кадр (много проходов), сбрасываем сами в начале render()
    this._infoReset = renderer.info.autoReset;
    renderer.info.autoReset = false;

    this.q = { ...QDEF };
    this.params = {
      exposure: 1, toneMapper: 'agx',
      bloomStrength: 0.05, bloomThreshold: 1.0, dirtStrength: 0.6,
      flash: 0, flashTint: new THREE.Color(1, 1, 1),
      adapt: 1, chroma: 0,
      shock: { strength: 0, center: new THREE.Vector3(), radius: 0, width: 0.3 },
      haze: { strength: 0, center: new THREE.Vector3(), radius: 0.05 },
      after: { strength: 0, offset: new THREE.Vector2() },
      vignette: 0.22, grain: 0.035,
    };
    this.fxUniforms = {
      tDepth: { value: null }, uCamNear: { value: 0.1 }, uCamFar: { value: 100 }, uFxRes: { value: new THREE.Vector2(1, 1) },
    };
    this.volume = null;

    this._cssW = 1; this._cssH = 1; this._dpr = 1;
    this._baseW = 1; this._baseH = 1;
    this._scale = 1; this._accum = 0; this._time = 0;
    this._w = 1; this._h = 1;

    // заранее созданные временные объекты
    this._v = new THREE.Vector3();
    this._clear = new THREE.Color();
    this._proj = new THREE.Matrix4();
    this._projInv = new THREE.Matrix4();
    this._fxClearDone = false;

    this._quadScene = new THREE.Scene();
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this._geo = geo;
    this._quad = new THREE.Mesh(geo, null);
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);

    this._dirt = makeDirtTexture();

    const compU = () => ({
      tScene: { value: null }, tFx: { value: null }, tVol: { value: null },
      uVolOn: { value: 0 }, uVolTexel: { value: new THREE.Vector2() },
    });
    const mat = (frag, uniforms) => new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: frag, uniforms,
      depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.NoBlending,
    });
    this._prefilter = mat(PREFILTER_FRAG, { ...compU(), uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 } });
    this._down = mat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this._up = mat(UP_FRAG, { tSrc: { value: null }, tCur: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this._capture = mat(CAPTURE_FRAG, { ...compU(), uStep: { value: new THREE.Vector2() } });
    this._copy = mat(COPY_FRAG, { tSrc: { value: null } });
    this._final = mat(FINAL_FRAG, {
      ...compU(),
      tBloom: { value: null }, tDirt: { value: this._dirt }, tAfter: { value: null }, uAfterLod: { value: 8 },
      uBloom: { value: 0 }, uDirt: { value: 0 }, uFlash: { value: new THREE.Color(0, 0, 0) },
      uChroma: { value: 0 }, uShock: { value: new THREE.Vector4() }, uShockStr: { value: 0 },
      uHaze: { value: new THREE.Vector4() }, uAfter: { value: new THREE.Vector3() },
      uExposure: { value: 1 }, uToneMapper: { value: 0 }, uVignette: { value: 0 }, uGrain: { value: 0 },
      uTime: { value: 0 }, uAspect: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) },
    });
    // накопление: out = mix(accum, frame, 1/n) через константную альфу блендинга
    this._blendFactors = [THREE.ConstantAlphaFactor, THREE.OneMinusConstantAlphaFactor];

    // мипы: последний уровень даёт среднюю яркость снимка для нормировки
    this._afterRT = new THREE.WebGLRenderTarget(256, 144, {
      type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    });
    this._warmRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    this._rts = null;
    this.setQuality(quality || QDEF);
  }

  setQuality(q) {
    q = q || {};
    const n = this.q;
    n.name = q.name ?? QDEF.name;
    n.msaa = q.msaa > 0 ? 4 : 0;
    n.bloomLevels = Math.max(2, Math.min(7, q.bloomLevels ?? QDEF.bloomLevels));
    n.fxScale = q.fxScale ?? QDEF.fxScale;
    n.volScale = q.volScale ?? QDEF.volScale;
    n.dirt = q.dirt ?? QDEF.dirt;
    n.grain = q.grain ?? QDEF.grain;
    this._alloc();
  }

  setSize(cssW, cssH, dpr = 1) {
    this._cssW = Math.max(1, cssW); this._cssH = Math.max(1, cssH); this._dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this._cssW, this._cssH);
    this._alloc();
  }

  setResolutionScale(s) {
    s = Math.min(1, Math.max(0.5, s));
    if (Math.abs(s - this._scale) < 1e-3) return;
    this._scale = s;
    this._alloc();
  }

  get info() { return { scale: this._scale, accum: this._accum, w: this._w, h: this._h }; }

  _disposeTargets() {
    const r = this._rts;
    if (!r) return;
    r.scene.depthTexture.dispose();
    r.scene.dispose(); r.fx.dispose(); r.vol.dispose(); r.accum.dispose();
    for (const t of r.down) t.dispose();
    for (const t of r.up) t.dispose();
  }

  _alloc() {
    this._disposeTargets();
    const q = this.q;
    const bw = this._baseW = Math.max(1, Math.floor(this._cssW * this._dpr));
    const bh = this._baseH = Math.max(1, Math.floor(this._cssH * this._dpr));
    const w = this._w = Math.max(1, Math.round(bw * this._scale));
    const h = this._h = Math.max(1, Math.round(bh * this._scale));
    const HF = { type: THREE.HalfFloatType, depthBuffer: false };
    const depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    const scene = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: q.msaa, depthBuffer: true, depthTexture, resolveDepthBuffer: true,
    });
    const fxW = Math.max(1, Math.round(w * q.fxScale)), fxH = Math.max(1, Math.round(h * q.fxScale));
    const fx = new THREE.WebGLRenderTarget(fxW, fxH, HF);
    const vol = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w * q.volScale)), Math.max(1, Math.round(h * q.volScale)), HF);
    const accum = new THREE.WebGLRenderTarget(bw, bh, HF);
    const down = [], up = [];
    let lw = w, lh = h;
    for (let i = 0; i < q.bloomLevels; i++) {
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
      down.push(new THREE.WebGLRenderTarget(lw, lh, HF));
      // верхний уровень up не нужен: берём down напрямую
      up.push(i < q.bloomLevels - 1 ? new THREE.WebGLRenderTarget(lw, lh, HF) : down[i]);
    }
    this._rts = { scene, fx, vol, accum, down, up };
    this._afterRT.setSize(256, Math.max(1, Math.round(256 * h / w)));
    this._accum = 0;
    this._fxClearDone = false;

    this.fxUniforms.tDepth.value = depthTexture;
    this.fxUniforms.uFxRes.value.set(fxW, fxH);
    for (const m of [this._prefilter, this._capture, this._final]) {
      m.uniforms.tScene.value = scene.texture;
      m.uniforms.tFx.value = fx.texture;
      m.uniforms.tVol.value = vol.texture;
      m.uniforms.uVolTexel.value.set(1 / vol.width, 1 / vol.height);
    }
    this._prefilter.uniforms.uTexel.value.set(1 / w, 1 / h);
    this._capture.uniforms.uStep.value.set(1 / this._afterRT.width, 1 / this._afterRT.height);
    this._final.uniforms.uAfterLod.value = Math.floor(Math.log2(Math.max(this._afterRT.width, this._afterRT.height)));
    this._final.uniforms.tBloom.value = up[0].texture;
    this._final.uniforms.tAfter.value = this._afterRT.texture;
    this._final.uniforms.uAspect.value = w / h;
    this._final.uniforms.uRes.value.set(bw, bh);
  }

  _pass(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._quadScene, this._quadCam);
  }

  // Проекция мировой точки в uv; возвращает масштаб «метр → доля высоты экрана» или 0, если сзади
  _projectToUv(p, camera, out4) {
    const v = this._v.copy(p).applyMatrix4(camera.matrixWorldInverse);
    const depth = -v.z;
    const persp = camera.isPerspectiveCamera === true;
    if (persp && depth < (camera.near || 0.01)) return 0;
    v.applyMatrix4(camera.projectionMatrix);
    out4.x = v.x * 0.5 + 0.5; out4.y = v.y * 0.5 + 0.5;
    return camera.projectionMatrix.elements[5] * 0.5 / (persp ? depth : 1);
  }

  _updateFinalUniforms(dt) {
    const p = this.params, q = this.q, u = this._final.uniforms;
    this._time += dt;
    u.uTime.value = this._time;
    u.uBloom.value = p.bloomStrength / q.bloomLevels;
    u.uDirt.value = q.dirt ? p.dirtStrength : 0;
    u.uFlash.value.copy(p.flashTint).multiplyScalar(p.flash);
    u.uChroma.value = p.chroma;
    u.uExposure.value = p.exposure * p.adapt;
    u.uToneMapper.value = p.toneMapper === 'aces' ? 1 : 0;
    u.uVignette.value = p.vignette;
    u.uGrain.value = q.grain ? p.grain : 0;
    u.uAfter.value.set(p.after.offset.x, p.after.offset.y, p.after.strength);
  }

  _updateCamUniforms(camera) {
    const p = this.params, u = this._final.uniforms;
    u.uShockStr.value = 0;
    if (p.shock.strength > 0 && p.shock.radius > 0) {
      const k = this._projectToUv(p.shock.center, camera, u.uShock.value);
      if (k > 0) {
        u.uShock.value.z = p.shock.radius * k;
        u.uShock.value.w = Math.max(p.shock.width * k, 1e-3);
        u.uShockStr.value = p.shock.strength;
      }
    }
    u.uHaze.value.w = 0;
    if (p.haze.strength > 0) {
      const k = this._projectToUv(p.haze.center, camera, u.uHaze.value);
      if (k > 0) { u.uHaze.value.z = Math.max(p.haze.radius * k, 1e-3); u.uHaze.value.w = p.haze.strength; }
    }
  }

  render(scene, fxScene, camera, dt = 0, accumIndex = 0) {
    this._render(scene, fxScene, camera, dt, accumIndex, null);
  }

  _render(scene, fxScene, camera, dt, accumIndex, outTarget) {
    const r = this.renderer, rts = this._rts;
    if (this._infoReset) r.info.reset();
    r.toneMapping = THREE.NoToneMapping;
    const autoClear = r.autoClear;
    r.autoClear = true;

    // субпиксельный сдвиг Halton(2,3) для прогрессивного сглаживания
    const jitter = accumIndex > 0;
    if (jitter) {
      this._proj.copy(camera.projectionMatrix);
      this._projInv.copy(camera.projectionMatrixInverse);
      const jx = (halton(accumIndex, 2) - 0.5) * 2 / this._w;
      const jy = (halton(accumIndex, 3) - 0.5) * 2 / this._h;
      const e = camera.projectionMatrix.elements;
      if (camera.isPerspectiveCamera) { e[8] += jx; e[9] += jy; } else { e[12] += jx; e[13] += jy; }
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }

    r.setRenderTarget(rts.scene);
    r.render(scene, camera);

    r.getClearColor(this._clear);
    const clearAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);

    const fu = this.fxUniforms;
    fu.uCamNear.value = camera.near ?? 0.1;
    fu.uCamFar.value = camera.far ?? 100;
    if (fxScene) {
      r.setRenderTarget(rts.fx);
      r.render(fxScene, camera);
      this._fxClearDone = false;
    } else if (!this._fxClearDone) {
      r.setRenderTarget(rts.fx); r.clear(true, false, false);
      this._fxClearDone = true;
    }

    const volOn = !!(this.volume && this.volume.enabled);
    if (volOn) {
      r.setRenderTarget(rts.vol); r.clear(true, false, false);
      this.volume.render(r, camera, rts.scene.depthTexture, rts.vol);
    }
    r.setClearColor(this._clear, clearAlpha);
    // полноэкранные проходы перезаписывают всё; без очистки, иначе сломается смешивание накопления
    r.autoClear = false;
    const vo = volOn ? 1 : 0;
    this._prefilter.uniforms.uVolOn.value = vo;
    this._capture.uniforms.uVolOn.value = vo;
    this._final.uniforms.uVolOn.value = vo;

    if (jitter) {
      camera.projectionMatrix.copy(this._proj);
      camera.projectionMatrixInverse.copy(this._projInv);
    }

    // bloom: prefilter → down-цепочка → up с добавлением
    const L = this.q.bloomLevels;
    this._prefilter.uniforms.uThreshold.value = this.params.bloomThreshold;
    this._pass(this._prefilter, rts.down[0]);
    for (let i = 1; i < L; i++) {
      const src = rts.down[i - 1];
      this._down.uniforms.tSrc.value = src.texture;
      this._down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._pass(this._down, rts.down[i]);
    }
    for (let i = L - 2; i >= 0; i--) {
      const src = rts.up[i + 1];
      this._up.uniforms.tSrc.value = src.texture;
      this._up.uniforms.tCur.value = rts.down[i].texture;
      this._up.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._pass(this._up, rts.up[i]);
    }

    this._updateFinalUniforms(dt);
    this._updateCamUniforms(camera);

    const fin = this._final;
    if (accumIndex > 0) {
      fin.blending = THREE.CustomBlending;
      fin.blendEquation = THREE.AddEquation;
      fin.blendSrc = this._blendFactors[0];
      fin.blendDst = this._blendFactors[1];
      fin.blendAlpha = 1 / accumIndex;
      this._pass(fin, rts.accum);
      fin.blending = THREE.NoBlending;
      this._copy.uniforms.tSrc.value = rts.accum.texture;
      this._pass(this._copy, outTarget);
      this._accum = accumIndex;
    } else {
      this._pass(fin, outTarget);
      this._accum = 0;
    }
    r.autoClear = autoClear;
  }

  // Копия текущего HDR-кадра (scene+fx+объём, до тонмаппинга) в низкое разрешение
  captureAfterimage() {
    const r = this.renderer;
    const prev = r.getRenderTarget(), ac = r.autoClear;
    r.autoClear = false;
    this._pass(this._capture, this._afterRT);
    r.autoClear = ac;
    r.setRenderTarget(prev);
  }

  // Прогрев: один кадр со всеми ветками «включёнными» в скрытую цель, чтобы не было
  // компиляции шейдеров на первом взрыве.
  warmup(scene, fxScene, camera) {
    const p = this.params;
    const save = {
      flash: p.flash, chroma: p.chroma, s: p.shock.strength, sr: p.shock.radius, h: p.haze.strength,
      a: p.after.strength, tm: p.toneMapper, t: this._time,
    };
    const vol = this.volume, volEnabled = vol ? vol.enabled : false;
    if (vol) vol.enabled = true;
    const shockC = p.shock.center.clone(), hazeC = p.haze.center.clone();
    // центры перед камерой, чтобы ветки реально исполнились
    camera.updateMatrixWorld();
    const front = new THREE.Vector3(0, 0, -2).applyMatrix4(camera.matrixWorld);
    p.shock.center.copy(front); p.haze.center.copy(front);
    p.flash = 1; p.chroma = 0.5; p.shock.strength = 1; p.shock.radius = 0.5; p.haze.strength = 1; p.after.strength = 1;
    for (const tm of ['aces', 'agx']) {
      p.toneMapper = tm;
      this._render(scene, fxScene, camera, 0, 0, this._warmRT);
    }
    this.captureAfterimage();
    this._render(scene, fxScene, camera, 0, 1, this._warmRT);
    p.flash = save.flash; p.chroma = save.chroma; p.shock.strength = save.s; p.shock.radius = save.sr;
    p.haze.strength = save.h; p.after.strength = save.a; p.toneMapper = save.tm;
    p.shock.center.copy(shockC); p.haze.center.copy(hazeC);
    if (vol) vol.enabled = volEnabled;
    this._time = save.t;
    this._accum = 0;
    this.renderer.setRenderTarget(null);
  }

  dispose() {
    this._disposeTargets();
    this._rts = null;
    this._afterRT.dispose(); this._warmRT.dispose();
    for (const m of [this._prefilter, this._down, this._up, this._capture, this._copy, this._final]) m.dispose();
    this._geo.dispose();
    this._dirt.dispose();
    this.renderer.info.autoReset = this._infoReset;
  }
}
