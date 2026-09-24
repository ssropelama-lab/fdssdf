// Камеры: свободная орбита, «режиссёр» (следит за гранатой, перед взрывом — общий план,
// после — предлагает повтор) и камера повтора. Тряска приходит с задержкой d/343.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _desired = new THREE.Vector3(), _look = new THREE.Vector3();

export class Director {
  constructor(camera, dom) {
    this.camera = camera;
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.08;
    this.controls.maxDistance = 12;
    this.controls.maxPolarAngle = Math.PI * 0.53;
    this.controls.zoomSpeed = 0.8;
    this.mode = 'director';
    this.shot = 'hand';          // hand | chase | wide | replay
    this.lookAt = new THREE.Vector3();
    this.smoothTarget = new THREE.Vector3();
    this.bounds = null;
    this.userBusy = false;
    this.moved = true;
    this.wideDist = 4;
    this.shake = new THREE.Vector3();
    this.shakeRot = new THREE.Euler();
    this._prevPos = new THREE.Vector3();
    this._prevQuat = new THREE.Quaternion();
    this.replayCenter = new THREE.Vector3();
    this.controls.addEventListener('start', () => { this.userBusy = true; if (this.shot !== 'replay' && this.shot !== 'hand') this.userOverride = true; });
    this.controls.addEventListener('end', () => { this.userBusy = false; });
  }

  home(target, dist = 0.34) {
    this.shot = 'hand';
    this.userOverride = false;
    this.controls.target.copy(target);
    this.smoothTarget.copy(target);
    this.camera.position.copy(target).add(_v.set(0.55, 0.32, 0.78).normalize().multiplyScalar(dist));
    this.controls.enabled = true;
    this.controls.autoRotate = false;
    this.controls.update();
  }

  clampToBounds(p) {
    if (!this.bounds) return p;
    return p.clamp(this.bounds.min, this.bounds.max);
  }

  // ctx: { focus, vel, thrown, fuseLeft, blasted, dt }
  update(dt, ctx) {
    const c = this.controls;
    const k = 1 - Math.exp(-dt * 5);
    if (this.shot === 'replay') {
      c.update(dt);
    } else if (this.mode === 'free' || this.userOverride || !ctx.thrown) {
      // свободная: цель мягко следует за гранатой
      this.smoothTarget.lerp(ctx.focus, ctx.thrown ? k : 1);
      _v.subVectors(this.smoothTarget, c.target);
      // в руке камера едет вместе с гранатой, после броска — только поворачивается за ней
      if (_v.lengthSq() > 1e-10) { c.target.add(_v); if (!ctx.thrown) this.camera.position.add(_v); }
      c.enabled = true;
      c.update(dt);
    } else {
      c.enabled = false;
      if (ctx.blasted || ctx.fuseLeft < 0.9 || (ctx.speed < 0.05 && ctx.thrownFor > 0.8)) this.shot = 'wide';
      else this.shot = 'chase';
      this.smoothTarget.lerp(ctx.focus, 1 - Math.exp(-dt * 9));
      if (this.shot === 'chase') {
        // позади и выше гранаты по направлению полёта
        _w.copy(ctx.vel); _w.y = 0;
        if (_w.lengthSq() < 0.01) _w.subVectors(ctx.focus, this.camera.position).setY(0);
        _w.normalize();
        _desired.copy(ctx.focus).addScaledVector(_w, -1.3).add(_v.set(0, 0.55, 0));
        _desired.x += 0.35;
      } else {
        // общий план: с текущей стороны, на безопасной дистанции
        if (!this.wideLocked) {
          _w.subVectors(this.camera.position, ctx.focus).setY(0);
          if (_w.lengthSq() < 1e-4) _w.set(0, 0, 1);
          _w.normalize();
          this.wideDir = (this.wideDir || new THREE.Vector3()).copy(_w);
          this.wideLocked = true;
        }
        _desired.copy(ctx.focus).addScaledVector(this.wideDir, this.wideDist).add(_v.set(0, 1.25, 0));
      }
      this.clampToBounds(_desired);
      const kk = 1 - Math.exp(-dt * (this.shot === 'wide' ? 2.2 : 4));
      this.camera.position.lerp(_desired, kk);
      c.target.copy(this.smoothTarget);
      this.camera.lookAt(c.target);
    }
    this.moved = !this._prevPos.equals(this.camera.position) || !this._prevQuat.equals(this.camera.quaternion);
    if (this.moved) { this._prevPos.copy(this.camera.position); this._prevQuat.copy(this.camera.quaternion); }
    return this.moved;
  }

  resetShots() { this.wideLocked = false; this.userOverride = false; this.shot = 'hand'; }

  // Камера скоростной съёмки: рядом с точкой взрыва, медленный облёт
  startReplay(center, dist, height) {
    this.saved = { pos: this.camera.position.clone(), target: this.controls.target.clone(), shot: this.shot };
    this.shot = 'replay';
    this.replayCenter.copy(center);
    _w.subVectors(this.camera.position, center).setY(0);
    if (_w.lengthSq() < 1e-4) _w.set(0.6, 0, 1);
    _w.normalize();
    _desired.copy(center).addScaledVector(_w, dist); _desired.y = Math.max(0.15, center.y + height);
    this.clampToBounds(_desired);
    this.camera.position.copy(_desired);
    this.controls.target.copy(center);
    this.controls.enabled = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.update();
  }
  endReplay() {
    this.controls.autoRotate = false;
    if (this.saved) { this.camera.position.copy(this.saved.pos); this.controls.target.copy(this.saved.target); this.shot = this.saved.shot; }
    this.controls.update();
  }

  // Дистанция камеры повтора как функция времени взрыва (угол облёта сохраняется)
  setReplayDistance(d) {
    if (this.userBusy) return;
    _v.subVectors(this.camera.position, this.controls.target);
    const len = _v.length();
    if (len < 1e-6 || Math.abs(len - d) < 1e-4) return;
    _v.multiplyScalar(d / len);
    this.camera.position.copy(this.controls.target).add(_v);
  }

  // Тряска применяется только на время рендера, чтобы не копилась в OrbitControls
  applyShake(offset, rot) {
    this.shake.copy(offset);
    this.camera.position.add(offset);
    this.camera.rotation.x += rot.x; this.camera.rotation.y += rot.y; this.camera.rotation.z += rot.z;
    this.shakeRot.copy(rot);
    this.camera.updateMatrixWorld();
  }
  removeShake() {
    this.camera.position.sub(this.shake);
    this.camera.rotation.x -= this.shakeRot.x; this.camera.rotation.y -= this.shakeRot.y; this.camera.rotation.z -= this.shakeRot.z;
    this.shake.set(0, 0, 0); this.shakeRot.set(0, 0, 0);
    this.camera.updateMatrixWorld();
  }
}
