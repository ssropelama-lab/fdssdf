// Профили качества и автоподстройка разрешения по времени кадра.
export const PROFILES = {
  low: {
    name: 'low', dprCap: 1, msaa: 0, bloomLevels: 4, fxScale: 0.5, volScale: 0.25, volumetric: false, volSteps: 16,
    shadowSize: 1024, fragments: 260, sparks: 0.5, dirt: true, grain: false, accumMax: 8,
  },
  med: {
    name: 'med', dprCap: 1.5, msaa: 4, bloomLevels: 5, fxScale: 0.5, volScale: 0.25, volumetric: true, volSteps: 20,
    shadowSize: 2048, fragments: 400, sparks: 0.8, dirt: true, grain: true, accumMax: 24,
  },
  high: {
    name: 'high', dprCap: 2, msaa: 4, bloomLevels: 6, fxScale: 1, volScale: 0.5, volumetric: true, volSteps: 32,
    shadowSize: 2048, fragments: 560, sparks: 1, dirt: true, grain: true, accumMax: 32,
  },
};

// Первичная оценка по GPU: встройка → med, мобильные → low, дискретные/Apple M → high.
export function guessProfile(renderer) {
  const gl = renderer.getContext();
  let name = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch { /* нет доступа — не страшно */ }
  name = String(name).toLowerCase();
  const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent) || /mali|adreno|powervr|apple gpu/.test(name);
  if (mobile) return { profile: 'low', gpu: name };
  if (/swiftshader|llvmpipe|software/.test(name)) return { profile: 'low', gpu: name };
  if (/nvidia|geforce|rtx|radeon rx|apple m\d/.test(name)) return { profile: 'high', gpu: name };
  return { profile: 'med', gpu: name };
}

// Динамическое разрешение: держим p90 времени кадра у цели, шаги по 0.1 с гистерезисом.
export class DynamicResolution {
  constructor(target = 1000 / 60) {
    this.target = target; this.scale = 1; this.min = 0.5; this.max = 1;
    this.buf = new Float32Array(45); this.n = 0; this.cool = 0; this.enabled = true;
  }
  push(ms) {
    this.buf[this.n++ % this.buf.length] = ms;
    if (this.cool > 0) { this.cool--; return false; }
    if (!this.enabled || this.n < this.buf.length) return false;
    let avg = 0;
    for (let i = 0; i < this.buf.length; i++) avg += this.buf[i];
    avg /= this.buf.length;
    // rAF-интервал упирается во vsync, поэтому вверх идём осторожно: при стабильной цели и долгой паузе
    let next = this.scale;
    if (avg > this.target * 1.25) { next = Math.max(this.min, this.scale - 0.1); this.upWait = 300; }
    else if (avg < this.target * 1.08 && !(this.upWait > 0)) next = Math.min(this.max, this.scale + 0.1);
    if (this.upWait > 0) this.upWait -= this.buf.length;
    if (next !== this.scale) { this.scale = Math.round(next * 10) / 10; this.cool = 60; this.n = 0; return true; }
    return false;
  }
  // Оценка частоты дисплея по минимальному интервалу
  calibrate(ms) { if (ms > 4 && ms < this.target) this.target = Math.max(ms, 1000 / 144); }
}
