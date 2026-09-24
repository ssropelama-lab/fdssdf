// Сцены: «Студия» (осмотр) и «Полигон» (бетонный зал с укрытием). Набор источников света
// одинаковый в обеих, чтобы переключение не пересобирало шейдеры.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mulberry32 } from './rng.js';

export const TABLE_TOP = 0.9;

function noiseCanvas(size, seed, base, spread, specks) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const rnd = mulberry32(seed);
  // грубый value-noise из нескольких октав, тайлится
  const oct = [8, 16, 32, 64];
  const grids = oct.map((n) => { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0, amp = 0.5, tot = 0;
    for (let o = 0; o < oct.length; o++) {
      const n = oct[o], gx = (x / size) * n, gy = (y / size) * n;
      const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
      const a = grids[o], i0 = ix % n, i1 = (ix + 1) % n, j0 = iy % n, j1 = (iy + 1) % n;
      const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
      const top = a[j0 * n + i0] * (1 - u) + a[j0 * n + i1] * u, bot = a[j1 * n + i0] * (1 - u) + a[j1 * n + i1] * u;
      v += amp * (top * (1 - w) + bot * w); tot += amp; amp *= 0.55;
    }
    v /= tot;
    let s = rnd() < specks ? (rnd() - 0.5) * 0.5 : 0;
    const l = Math.max(0, Math.min(1, base + (v - 0.5) * spread + s));
    const o = (y * size + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = l * 255; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function tex(canvas, repeat, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Stage {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.name = 'stage';
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.env;
    this.scene.environmentIntensity = 0.55;

    // Общий свет: ключевой с тенью (следит за гранатой), заполняющий, контровой, небо
    const key = this.key = new THREE.DirectionalLight(0xfff1e0, 2.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.01;
    const sc = key.shadow.camera; sc.left = -1.3; sc.right = 1.3; sc.top = 1.3; sc.bottom = -1.3; sc.near = 0.1; sc.far = 12;
    key.shadow.autoUpdate = false;
    key.shadow.needsUpdate = true;
    this.keyOffset = new THREE.Vector3(2.2, 4.2, 2.6);
    this.scene.add(key, key.target);
    this.fill = new THREE.DirectionalLight(0xa8c4ff, 0.45);
    this.fill.position.set(-3, 1.6, 2.5);
    this.rim = new THREE.DirectionalLight(0xd8e6ff, 1.2);
    this.rim.position.set(-1.5, 2.8, -4);
    this.hemi = new THREE.HemisphereLight(0xb8c4d0, 0x1a1a1c, 0.35);
    this.scene.add(this.fill, this.rim, this.hemi);

    this.focus = new THREE.Vector3(0, TABLE_TOP, 0);
    this.sunDir = new THREE.Vector3().copy(this.keyOffset).normalize();

    const concrete = noiseCanvas(512, 7, 0.52, 0.26, 0.05);
    const concreteWall = noiseCanvas(512, 9, 0.6, 0.22, 0.03);
    const rough = noiseCanvas(256, 8, 0.8, 0.35, 0.02);
    this.mats = {
      floor: new THREE.MeshStandardMaterial({ color: 0x8a8a86, map: tex(concrete, 9, true), roughnessMap: tex(rough, 9), roughness: 1, metalness: 0 }),
      wall: new THREE.MeshStandardMaterial({ color: 0x8e8c88, map: tex(concreteWall, 2, true), roughnessMap: tex(rough, 3), roughness: 1 }),
      block: new THREE.MeshStandardMaterial({ color: 0x8c8a84, map: tex(concrete, 1, true), roughness: 0.95 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x6b4e33, roughness: 0.75 }),
      crate: new THREE.MeshStandardMaterial({ color: 0x5d5a3c, roughness: 0.8 }),
      table: new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.55, metalness: 0.2 }),
      tableTop: new THREE.MeshStandardMaterial({ color: 0x3b3a36, roughness: 0.62, metalness: 0.0 }),
      studio: new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.85 }),
      lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.9, 2.7) }),
    };
    this.groups = { studio: this.buildStudio(), range: this.buildRange() };
    this.table = this.buildTable();
    this.scene.add(this.groups.studio, this.groups.range, this.table);
    this.name = 'range';
  }

  buildTable() {
    const g = new THREE.Group(); g.name = 'table';
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.7), this.mats.tableTop);
    top.position.y = TABLE_TOP - 0.02;
    g.add(top);
    const legG = new THREE.BoxGeometry(0.04, TABLE_TOP - 0.04, 0.04);
    for (const [x, z] of [[-0.46, -0.31], [0.46, -0.31], [-0.46, 0.31], [0.46, 0.31]]) {
      const l = new THREE.Mesh(legG, this.mats.table);
      l.position.set(x, (TABLE_TOP - 0.04) / 2, z); g.add(l);
    }
    // коврик для осмотра
    const mat = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.004, 0.26), new THREE.MeshStandardMaterial({ color: 0x1d2a22, roughness: 0.95 }));
    mat.position.set(0, TABLE_TOP + 0.002, 0);
    g.add(mat);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.tableBox = { min: new THREE.Vector3(-0.5, 0, -0.35), max: new THREE.Vector3(0.5, TABLE_TOP + 0.004, 0.35) };
    return g;
  }

  buildStudio() {
    const g = new THREE.Group(); g.name = 'studio';
    // бесшовный циклорама-фон: пол, плавно переходящий в стену
    const shape = [];
    const R = 1.6;
    for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI / 2; shape.push([-3.4 + R - Math.sin(a) * R, R - Math.cos(a) * R]); }
    const W = 10, pos = [], idx = [];
    const pts = [[6, 0], ...shape.map(([z, y]) => [z, y]), [-3.4, 5]];
    for (let i = 0; i < pts.length; i++) { const [z, y] = pts[i]; pos.push(-W / 2, y, z, W / 2, y, z); }
    for (let i = 0; i < pts.length - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    const cyc = new THREE.Mesh(geo, this.mats.studio);
    cyc.receiveShadow = true;
    g.add(cyc);
    this.studioStatics = {
      planes: [[0, 1, 0, 0], [0, 0, 1, -3.4], [0, 0, -1, -6], [1, 0, 0, -5], [-1, 0, 0, -5]],
      boxes: [],
      bounds: { min: new THREE.Vector3(-4.8, 0.05, -3.2), max: new THREE.Vector3(4.8, 4, 5.8) },
    };
    this.studioOccluders = [cyc];
    return g;
  }

  buildRange() {
    const g = new THREE.Group(); g.name = 'range';
    const X = 6, Z0 = -15, Z1 = 5, H = 4.2;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * X, Z1 - Z0), this.mats.floor);
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0, (Z0 + Z1) / 2); floor.receiveShadow = true;
    g.add(floor);
    const wall = (w, h, x, y, z, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.mats.wall);
      m.position.set(x, y, z); m.rotation.y = ry; m.receiveShadow = true; g.add(m); return m;
    };
    const walls = [
      wall(2 * X, H, 0, H / 2, Z0, 0), wall(2 * X, H, 0, H / 2, Z1, Math.PI),
      wall(Z1 - Z0, H, -X, H / 2, (Z0 + Z1) / 2, Math.PI / 2), wall(Z1 - Z0, H, X, H / 2, (Z0 + Z1) / 2, -Math.PI / 2),
    ];
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(2 * X, Z1 - Z0), this.mats.wall);
    ceil.rotation.x = Math.PI / 2; ceil.position.set(0, H, (Z0 + Z1) / 2); g.add(ceil);
    // светильники на потолке (только визуально)
    for (let z = -12; z <= 3; z += 5) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.04, 0.18), this.mats.lamp);
      l.position.set(0, H - 0.03, z); g.add(l);
    }
    // укрытие и ящики
    const boxes = [];
    const addBox = (w, h, d, x, z, mat) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, h / 2, z); m.castShadow = m.receiveShadow = true; g.add(m);
      boxes.push({ min: new THREE.Vector3(x - w / 2, 0, z - d / 2), max: new THREE.Vector3(x + w / 2, h, z + d / 2), mesh: m });
      return m;
    };
    addBox(2.4, 1.05, 0.4, 1.4, -6.5, this.mats.block);
    addBox(0.6, 0.6, 0.6, -3.2, -9.2, this.mats.crate);
    addBox(0.6, 0.6, 0.6, -2.5, -9.4, this.mats.crate);
    addBox(0.8, 0.5, 0.8, 3.8, -10.5, this.mats.crate);
    this.rangeStatics = {
      planes: [[0, 1, 0, 0], [0, -1, 0, -H], [0, 0, 1, Z0], [0, 0, -1, -Z1], [1, 0, 0, -X], [-1, 0, 0, -X]],
      boxes,
      bounds: { min: new THREE.Vector3(-X + 0.2, 0.05, Z0 + 0.2), max: new THREE.Vector3(X - 0.2, H - 0.1, Z1 - 0.2) },
    };
    this.rangeOccluders = [floor, ceil, ...walls, ...boxes.map((b) => b.mesh)];
    return g;
  }

  // Применить сцену: видимость, свет, статика физики
  use(name, world) {
    this.name = name;
    const studio = name === 'studio';
    this.groups.studio.visible = studio;
    this.groups.range.visible = !studio;
    this.key.intensity = studio ? 3.0 : 2.2;
    this.rim.intensity = studio ? 1.8 : 0.6;
    this.fill.intensity = studio ? 0.5 : 0.35;
    this.hemi.intensity = studio ? 0.12 : 0.45;
    this.scene.environmentIntensity = studio ? 0.45 : 0.6;
    this.scene.background = new THREE.Color(studio ? 0x0d0e10 : 0x1a1a1a);
    const st = studio ? this.studioStatics : this.rangeStatics;
    this.statics = st;
    this.occluders = [...(studio ? this.studioOccluders : this.rangeOccluders), this.table.children[0]];
    if (world) {
      world.clearStatics();
      for (const [x, y, z, d] of st.planes) world.addPlane(new THREE.Vector3(x, y, z), d, { mu: 0.6, e: 0.3 });
      for (const b of st.boxes) world.addBox(b.min, b.max, { mu: 0.5, e: 0.25 });
      world.addBox(this.tableBox.min, this.tableBox.max, { mu: 0.45, e: 0.2 });
    }
    this.key.shadow.needsUpdate = true;
  }

  // Тень ключевого света следует за точкой интереса
  setFocus(p) {
    if (this.focus.distanceToSquared(p) < 1e-6) return false;
    this.focus.copy(p);
    this.key.target.position.copy(p);
    this.key.position.copy(p).add(this.keyOffset);
    this.key.target.updateMatrixWorld();
    this.key.updateMatrixWorld();
    this.key.shadow.needsUpdate = true;
    return true;
  }
}
