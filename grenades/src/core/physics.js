// Лёгкая физика твёрдых тел: тело = набор сфер-коллайдеров, окружение = плоскости и AABB.
// Импульсы с трением по Кулону, сопротивление качению, сон. Шаг фиксированный 1/240 с.
import * as THREE from 'three';

const G = -9.81;
const _r = new THREE.Vector3(), _p = new THREE.Vector3(), _n = new THREE.Vector3(), _vp = new THREE.Vector3();
const _t = new THREE.Vector3(), _tmp = new THREE.Vector3(), _tmp2 = new THREE.Vector3(), _q = new THREE.Quaternion();
const _m3 = new THREE.Matrix3(), _rot = new THREE.Matrix3(), _rotT = new THREE.Matrix3();

export class Body {
  // colliders: [{p: Vector3 (локаль), r}], inertia: Vector3 (диагональ, в локали)
  constructor({ colliders, mass, inertia, restitution = 0.3, friction = 0.5, rolling = 0.02, drag = 0.02, spinDrag = 0.05 }) {
    this.colliders = colliders.map((c) => ({ p: c.p.clone(), r: c.r }));
    this.mass = mass; this.invMass = 1 / mass;
    this.invI = new THREE.Vector3(1 / inertia.x, 1 / inertia.y, 1 / inertia.z);
    this.pos = new THREE.Vector3(); this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3(); this.ang = new THREE.Vector3();
    this.e = restitution; this.mu = friction; this.crr = rolling; this.drag = drag; this.spinDrag = spinDrag;
    this.enabled = false; this.sleeping = false; this.still = 0;
    this.contact = false; this.onHit = null;        // onHit(body, speed, point)
    this.invIw = new THREE.Matrix3();
    this.lastHit = -1;
  }
  // Мировой тензор инерции (обратный): R·I⁻¹·Rᵀ
  updateInertia() {
    _rot.setFromMatrix4(_m4.makeRotationFromQuaternion(this.quat));
    _rotT.copy(_rot).transpose();
    const e = _m3.identity().elements;
    e[0] = this.invI.x; e[4] = this.invI.y; e[8] = this.invI.z;
    this.invIw.multiplyMatrices(_rot, _m3).multiply(_rotT);
  }
  wake() { this.sleeping = false; this.still = 0; }
  applyImpulse(j, r) {
    this.vel.addScaledVector(j, this.invMass);
    _tmp.crossVectors(r, j).applyMatrix3(this.invIw);
    this.ang.add(_tmp);
  }
  pointVelocity(r, out) { return out.crossVectors(this.ang, r).add(this.vel); }
  // Эффективная масса вдоль направления n в точке r
  kFor(r, n) {
    _tmp.crossVectors(r, n).applyMatrix3(this.invIw);
    _tmp2.crossVectors(_tmp, r);
    return this.invMass + n.dot(_tmp2);
  }
  copyTo(obj) { obj.position.copy(this.pos); obj.quaternion.copy(this.quat); }
}
const _m4 = new THREE.Matrix4();

export class World {
  constructor() {
    this.planes = [];   // {n: Vector3, d} : n·x = d, внутрь комнаты
    this.boxes = [];    // {min, max, mu, e}
    this.bodies = [];
    this.acc = 0;
    this.dt = 1 / 240;
    this.time = 0;
  }
  addPlane(n, d, props = {}) { this.planes.push({ n: n.clone().normalize(), d, mu: props.mu ?? 0.55, e: props.e ?? 0.35 }); }
  addBox(min, max, props = {}) { this.boxes.push({ min: min.clone(), max: max.clone(), mu: props.mu ?? 0.5, e: props.e ?? 0.3 }); }
  clearStatics() { this.planes.length = 0; this.boxes.length = 0; }
  add(b) { if (!this.bodies.includes(b)) this.bodies.push(b); return b; }
  remove(b) { const i = this.bodies.indexOf(b); if (i >= 0) this.bodies.splice(i, 1); }

  step(frameDt) {
    this.acc = Math.min(this.acc + frameDt, this.dt * 10);
    let n = 0;
    while (this.acc >= this.dt) { this.substep(this.dt); this.acc -= this.dt; n++; }
    return n;
  }

  substep(dt) {
    this.time += dt;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.enabled || b.sleeping) continue;
      b.vel.y += G * dt;
      b.vel.multiplyScalar(1 - b.drag * dt);
      b.ang.multiplyScalar(1 - b.spinDrag * dt);
      b.pos.addScaledVector(b.vel, dt);
      // интегрирование ориентации: q += ½·ω·q·dt
      _q.set(b.ang.x, b.ang.y, b.ang.z, 0).multiply(b.quat);
      b.quat.x += 0.5 * _q.x * dt; b.quat.y += 0.5 * _q.y * dt; b.quat.z += 0.5 * _q.z * dt; b.quat.w += 0.5 * _q.w * dt;
      b.quat.normalize();
      b.updateInertia();
      b.contact = false;
      for (let it = 0; it < 2; it++) this.collide(b, dt, it === 0);
      if (b.contact) {
        // сопротивление качению: гасит вращение и скорость у лежащего на полу тела
        const k = Math.max(0, 1 - b.crr * 60 * dt);
        b.ang.multiplyScalar(k);
        b.vel.x *= 1 - b.crr * 6 * dt; b.vel.z *= 1 - b.crr * 6 * dt;
      }
      const still = b.vel.lengthSq() < 0.0004 && b.ang.lengthSq() < 0.01;
      b.still = still ? b.still + dt : 0;
      if (b.contact && b.still > 0.4) { b.sleeping = true; b.vel.set(0, 0, 0); b.ang.set(0, 0, 0); }
    }
  }

  collide(b, dt, report) {
    for (let c = 0; c < b.colliders.length; c++) {
      const col = b.colliders[c];
      _p.copy(col.p).applyQuaternion(b.quat).add(b.pos);
      for (let i = 0; i < this.planes.length; i++) {
        const pl = this.planes[i];
        const depth = col.r - (_p.dot(pl.n) - pl.d);
        if (depth > 0) {
          _n.copy(pl.n);
          this.resolve(b, _n, depth, col.r, pl.mu, pl.e, report);
          _p.copy(col.p).applyQuaternion(b.quat).add(b.pos);
        }
      }
      for (let i = 0; i < this.boxes.length; i++) {
        const bx = this.boxes[i];
        _tmp.copy(_p).clamp(bx.min, bx.max);
        _n.subVectors(_p, _tmp);
        let dist = _n.length();
        let depth;
        if (dist > 1e-6) {
          depth = col.r - dist;
          if (depth <= 0) continue;
          _n.multiplyScalar(1 / dist);
        } else {
          // центр сферы внутри ящика — выталкиваем по ближайшей грани
          const dx0 = _p.x - bx.min.x, dx1 = bx.max.x - _p.x, dy0 = _p.y - bx.min.y, dy1 = bx.max.y - _p.y, dz0 = _p.z - bx.min.z, dz1 = bx.max.z - _p.z;
          const m = Math.min(dx0, dx1, dy0, dy1, dz0, dz1);
          _n.set(m === dx0 ? -1 : m === dx1 ? 1 : 0, m === dy0 ? -1 : m === dy1 ? 1 : 0, m === dz0 ? -1 : m === dz1 ? 1 : 0);
          depth = m + col.r;
        }
        this.resolve(b, _n, depth, col.r, bx.mu, bx.e, report);
        _p.copy(col.p).applyQuaternion(b.quat).add(b.pos);
      }
    }
  }

  resolve(b, n, depth, radius, mu, e, report) {
    b.contact = true;
    // точка контакта на поверхности сферы, r — от центра масс
    _r.copy(_p).addScaledVector(n, -radius).sub(b.pos);
    b.pointVelocity(_r, _vp);
    const vn = _vp.dot(n);
    if (vn < 0) {
      const rest = vn < -0.35 ? (b.e + e) * 0.5 : 0;
      const jn = -(1 + rest) * vn / b.kFor(_r, n);
      _t.copy(n).multiplyScalar(jn);
      b.applyImpulse(_t, _r);
      if (report && vn < -0.25 && b.onHit && this.time - b.lastHit > 0.03) {
        b.lastHit = this.time;
        b.onHit(b, -vn, _tmp2.copy(_p).addScaledVector(n, -radius));
      }
      // трение
      b.pointVelocity(_r, _vp);
      const vn2 = _vp.dot(n);
      _t.copy(_vp).addScaledVector(n, -vn2);
      const vt = _t.length();
      if (vt > 1e-5) {
        _t.multiplyScalar(1 / vt);
        let jt = vt / b.kFor(_r, _t);
        const maxF = Math.max(mu, b.mu) * jn;
        if (jt > maxF) jt = maxF;
        _t.multiplyScalar(-jt);
        b.applyImpulse(_t, _r);
      }
    }
    b.pos.addScaledVector(n, depth * 0.85);
    if (b.sleeping) b.wake();
  }

  // Луч против статики (для осколков): возвращает дистанцию и нормаль
  raycast(o, d, maxT, outN) {
    let best = maxT, hit = false;
    for (let i = 0; i < this.planes.length; i++) {
      const pl = this.planes[i];
      const den = d.dot(pl.n);
      if (den >= -1e-6) continue;
      const t = (pl.d - o.dot(pl.n)) / den;
      if (t > 0 && t < best) { best = t; outN.copy(pl.n); hit = true; }
    }
    for (let i = 0; i < this.boxes.length; i++) {
      const bx = this.boxes[i];
      let t0 = 0, t1 = best, axis = -1, sign = 0;
      let ok = true;
      for (let a = 0; a < 3 && ok; a++) {
        const oa = a === 0 ? o.x : a === 1 ? o.y : o.z, da = a === 0 ? d.x : a === 1 ? d.y : d.z;
        const mn = a === 0 ? bx.min.x : a === 1 ? bx.min.y : bx.min.z, mx = a === 0 ? bx.max.x : a === 1 ? bx.max.y : bx.max.z;
        if (Math.abs(da) < 1e-9) { if (oa < mn || oa > mx) ok = false; continue; }
        let ta = (mn - oa) / da, tb = (mx - oa) / da, s = -1;
        if (ta > tb) { const q = ta; ta = tb; tb = q; s = 1; }
        if (ta > t0) { t0 = ta; axis = a; sign = s; }
        if (tb < t1) t1 = tb;
        if (t0 > t1) ok = false;
      }
      if (ok && axis >= 0 && t0 > 0 && t0 < best) {
        best = t0; hit = true;
        outN.set(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
      }
    }
    return hit ? best : -1;
  }
}

// Инерция по форме
export const inertia = {
  sphere: (m, r) => { const i = 0.4 * m * r * r; return new THREE.Vector3(i, i, i); },
  cylinderY: (m, r, h) => new THREE.Vector3((m * (3 * r * r + h * h)) / 12, 0.5 * m * r * r, (m * (3 * r * r + h * h)) / 12),
  rod: (m, len, w, axis = 'y') => {
    const a = (m * (len * len + w * w)) / 12, b = (m * w * w) / 6;
    return axis === 'y' ? new THREE.Vector3(a, b, a) : axis === 'x' ? new THREE.Vector3(b, a, a) : new THREE.Vector3(a, a, b);
  },
};

// Запись траектории тела для перемотки: позиции/кватернионы с шагом dt
export class Track {
  constructor(seconds, hz = 240) {
    this.hz = hz; this.n = Math.ceil(seconds * hz) + 1;
    this.data = new Float32Array(this.n * 7); this.len = 0;
  }
  push(pos, quat) {
    if (this.len >= this.n) return;
    const o = this.len * 7, d = this.data;
    d[o] = pos.x; d[o + 1] = pos.y; d[o + 2] = pos.z; d[o + 3] = quat.x; d[o + 4] = quat.y; d[o + 5] = quat.z; d[o + 6] = quat.w;
    this.len++;
  }
  sample(t, pos, quat) {
    if (this.len === 0) return;
    const f = Math.max(0, t) * this.hz;
    const i = Math.min(this.len - 1, Math.floor(f)), j = Math.min(this.len - 1, i + 1), k = Math.min(1, f - i);
    const d = this.data, a = i * 7, b = j * 7;
    pos.set(d[a] + (d[b] - d[a]) * k, d[a + 1] + (d[b + 1] - d[a + 1]) * k, d[a + 2] + (d[b + 2] - d[a + 2]) * k);
    quat.set(d[a + 3], d[a + 4], d[a + 5], d[a + 6]);
    _q.set(d[b + 3], d[b + 4], d[b + 5], d[b + 6]);
    quat.slerp(_q, k);
  }
}
