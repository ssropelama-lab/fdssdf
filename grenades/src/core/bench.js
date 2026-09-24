// Стенд ?bench=1: сам проводит подрыв и пишет p95/p99 времени кадра и renderer.info.
export class Bench {
  constructor(renderer) {
    this.renderer = renderer;
    this.frames = new Float32Array(20000); this.n = 0;
    this.cpu = new Float32Array(20000);
    this.tags = new Uint8Array(20000);   // 1 — кадр в первую секунду после взрыва
    this.recording = false;
    this.marks = {};
    this.peak = { calls: 0, triangles: 0, points: 0 };
    const gl = renderer.getContext();
    this.gl = gl;
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.gpu = []; this.pending = [];
  }
  start() { this.recording = true; this.n = 0; this.marks.start = performance.now(); }
  mark(name) { this.marks[name] = performance.now(); if (name === 'blast') this.marks.programsAtBlast = this.renderer.info.programs.length; }
  gpuBegin() {
    if (!this.recording || !this.timerExt) return;
    const q = this.gl.createQuery(); this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q); this.cur = q;
  }
  gpuEnd() {
    if (!this.cur) return;
    this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT); this.pending.push(this.cur); this.cur = null;
    // забираем готовые результаты
    while (this.pending.length) {
      const q = this.pending[0];
      if (!this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE)) break;
      if (!this.gl.getParameter(this.timerExt.GPU_DISJOINT_EXT)) this.gpu.push(this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) / 1e6);
      this.gl.deleteQuery(q); this.pending.shift();
    }
  }
  // blastWin: кадр отрисован в первую секунду часов взрыва (включая самый первый кадр взрыва)
  frame(dtMs, cpuMs, blastWin) {
    if (!this.recording || this.n >= this.frames.length) return;
    this.frames[this.n] = dtMs; this.cpu[this.n] = cpuMs;
    this.tags[this.n] = blastWin ? 1 : 0;
    this.n++;
    const r = this.renderer.info.render;
    if (r.calls > this.peak.calls) this.peak.calls = r.calls;
    if (r.triangles > this.peak.triangles) this.peak.triangles = r.triangles;
  }
  report(extra = {}) {
    this.recording = false;
    const pct = (arr, p) => { if (!arr.length) return 0; const s = Array.from(arr).sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const f = this.frames.subarray(0, this.n), c = this.cpu.subarray(0, this.n);
    let over = 0, overBlast = 0, max = 0, maxBlast = 0, nBlast = 0;
    for (let i = 0; i < this.n; i++) {
      if (f[i] > 33.4) { over++; if (this.tags[i]) overBlast++; }
      if (f[i] > max) max = f[i];
      if (this.tags[i]) { nBlast++; if (f[i] > maxBlast) maxBlast = f[i]; }
    }
    const info = this.renderer.info;
    const res = {
      frames: this.n,
      frame_ms: { p50: +pct(f, 0.5).toFixed(2), p95: +pct(f, 0.95).toFixed(2), p99: +pct(f, 0.99).toFixed(2), max: +max.toFixed(2) },
      cpu_ms: { p50: +pct(c, 0.5).toFixed(2), p95: +pct(c, 0.95).toFixed(2), p99: +pct(c, 0.99).toFixed(2) },
      gpu_ms: this.gpu.length ? { p50: +pct(this.gpu, 0.5).toFixed(2), p95: +pct(this.gpu, 0.95).toFixed(2), p99: +pct(this.gpu, 0.99).toFixed(2) } : 'нет EXT_disjoint_timer_query',
      frames_over_33ms: over,
      first_blast: { frames: nBlast, frames_over_33ms: overBlast, max_ms: +maxBlast.toFixed(2) },
      programs: { at_blast: this.marks.programsAtBlast, after: info.programs.length, new_during_blast: info.programs.length - (this.marks.programsAtBlast ?? info.programs.length) },
      renderer_info: { peak_calls: this.peak.calls, peak_triangles: this.peak.triangles, geometries: info.memory.geometries, textures: info.memory.textures },
      ...extra,
    };
    const ok = nBlast > 0 && res.first_blast.frames_over_33ms === 0 && res.programs.new_during_blast === 0;
    res.verdict = ok ? 'OK: на первом взрыве нет кадров > 33 мс и новых шейдеров' : 'ВНИМАНИЕ: см. first_blast / programs';
    window.__BENCH__ = res;
    console.log('BENCH ' + JSON.stringify(res));
    return res;
  }
}
