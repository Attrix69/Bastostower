import * as THREE from 'three';
import { G, groups, Physics, RAPIER } from '../physics/Physics';
import { Materials } from './materials';
import { mat, roundedBox, StaticBatcher, tiledBox } from './geo';
import { createBuildingMaterial } from './buildingMaterial';
import { helipadTexture, textTexture } from './textures';
import { clamp } from '../core/math';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const ROOF = { minX: -13, maxX: 13, minZ: -10, maxZ: 10, y: 0 };
export const PARAPET_H = 0.55;
export const PARAPET_T = 0.4;
/** Below this height a fighter is considered lost to the void. */
export const FALL_Y = -2.2;

export type EdgeKind = 'gap' | 'parapet' | 'railing' | 'plank';

export interface EdgeZone {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** outward normal */
  nx: number;
  nz: number;
  kind: EdgeKind;
  railing?: RailingSegment;
}

const STATIC_GROUPS = groups(G.STATIC, G.ALL);

/** A breakable railing section: fixed until something heavy smashes into it. */
export class RailingSegment {
  broken = false;
  readonly mesh: THREE.Group;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private readonly home: THREE.Vector3;
  private readonly homeQ = new THREE.Quaternion();

  constructor(physics: Physics, center: THREE.Vector3, length: number, axis: 'x' | 'z', materials: Materials) {
    this.home = center.clone();
    const w = axis === 'x' ? length : 0.08;
    const d = axis === 'z' ? length : 0.08;
    const h = 1.05;
    const g = new THREE.Group();
    const metal = materials.metal;
    const parts: THREE.BufferGeometry[] = [];
    const add = (geo: THREE.BufferGeometry, m: THREE.Matrix4, color: number) => {
      const p = geo.clone();
      p.applyMatrix4(m);
      const n = p.attributes.position.count;
      const c = new THREE.Color(color);
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
      p.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      parts.push(p);
    };
    const rail = new THREE.CylinderGeometry(0.035, 0.035, length, 8);
    const post = new THREE.CylinderGeometry(0.04, 0.04, h, 8);
    const rot = axis === 'x' ? mat(0, 0, 0, 0, 0, Math.PI / 2) : mat(0, 0, 0, Math.PI / 2, 0, 0);
    for (const y of [h - 0.03, h * 0.55, 0.12]) {
      add(rail, new THREE.Matrix4().makeTranslation(0, y - h / 2, 0).multiply(rot), y > h * 0.9 ? 0xd8b23a : 0xb9bcc4);
    }
    for (const t of [-0.5, 0, 0.5]) {
      const off = t * (length - 0.1);
      add(post, mat(axis === 'x' ? off : 0, 0, axis === 'z' ? off : 0), 0xb9bcc4);
    }
    // hazard tag
    add(new THREE.BoxGeometry(axis === 'x' ? 0.5 : 0.02, 0.18, axis === 'z' ? 0.5 : 0.02), mat(0, 0.05, 0), 0xf5c400);
    const merged = new THREE.Mesh(mergeColored(parts), metal);
    merged.castShadow = true;
    merged.receiveShadow = true;
    g.add(merged);
    g.position.copy(center);
    this.mesh = g;

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z).setCcdEnabled(true),
    );
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2)
        .setCollisionGroups(STATIC_GROUPS)
        .setMass(28)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(2600),
      this.body,
    );
    physics.register(this.collider, { kind: 'railing', ref: this, material: 'metal' });
  }

  break(impulse: THREE.Vector3) {
    if (this.broken) return;
    this.broken = true;
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.collider.setCollisionGroups(groups(G.PROP, G.ALL));
    this.body.applyImpulse({ x: impulse.x, y: impulse.y + 40, z: impulse.z }, true);
    this.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * 30, y: (Math.random() - 0.5) * 20, z: (Math.random() - 0.5) * 30 }, true);
  }

  reset() {
    this.broken = false;
    this.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    this.body.setTranslation(this.home, false);
    this.body.setRotation(this.homeQ, false);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    this.collider.setCollisionGroups(STATIC_GROUPS);
    this.mesh.position.copy(this.home);
    this.mesh.quaternion.identity();
    this.mesh.visible = true;
  }

  sync() {
    if (!this.broken) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    if (t.y < -140) {
      this.mesh.visible = false;
      this.body.sleep();
    }
  }
}

function mergeColored(parts: THREE.BufferGeometry[]) {
  // all parts share position/normal/uv/color → simple manual merge to avoid index mismatch issues
  const geos = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  let count = 0;
  for (const g of geos) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    col.set(g.attributes.color.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

interface Spinner {
  obj: THREE.Object3D;
  speed: number;
}

/**
 * The rooftop: visuals (batched), static colliders, breakable railings,
 * edge/void knowledge for gameplay & AI, and the scene lighting.
 */
export class Arena {
  private static ventHeadGeo: THREE.BufferGeometry | null = null;
  private static finMat = new THREE.MeshStandardMaterial({ color: 0xd3d6dc, metalness: 0.8, roughness: 0.3 });
  private static bladeMat = new THREE.MeshStandardMaterial({ color: 0x9aa0aa, metalness: 0.6, roughness: 0.4 });
  readonly group = new THREE.Group();
  readonly edges: EdgeZone[] = [];
  readonly railings: RailingSegment[] = [];
  readonly spawns = {
    player: { pos: new THREE.Vector3(0, 0, 4.6), yaw: 0 },
    enemy: { pos: new THREE.Vector3(0, 0, -4.2), yaw: Math.PI },
  };
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private spinners: Spinner[] = [];
  private neonMat!: THREE.MeshBasicMaterial;
  private neonLight!: THREE.PointLight;
  private beacon!: THREE.MeshBasicMaterial;
  private neonFlicker = 0;
  private batch = new StaticBatcher();
  readonly facadeMaterial = createBuildingMaterial({ litRatio: 0.3 });
  /** Static obstacles as 2D boxes for AI steering (x,z,halfX,halfZ). */
  readonly obstacles: { x: number; z: number; hx: number; hz: number }[] = [];

  constructor(
    private physics: Physics,
    private materials: Materials,
  ) {
    this.group.name = 'arena';
    this.buildSlab();
    this.buildParapets();
    this.buildStairHouse(-9, -6.5);
    this.buildACUnit(7, -7.2);
    this.buildACUnit(9.7, -7.2);
    this.buildPipes();
    for (const [x, z] of [[-2.8, -8.4], [3.0, 8.3], [11.4, 4.6], [-11.7, 1.4]] as const) this.buildVent(x, z);
    this.buildChimney(-5.4, 7.6);
    this.buildChimney(10.9, -2.6);
    this.buildSkylight(5.6, 3.4);
    this.buildSolarPanels();
    this.buildPartyCorner();
    this.buildPlank();
    this.buildBillboard();
    this.buildMarkings();
    this.batch.build(this.group);

    // lighting — golden hour from the west
    this.hemi = new THREE.HemisphereLight(0x8a90e0, 0x3a2a30, 0.85);
    this.group.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffb27a, 3.7);
    this.sun.position.set(-34, 21, 14);
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -19;
    sc.right = 19;
    sc.top = 15;
    sc.bottom = -15;
    sc.near = 5;
    sc.far = 90;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 2.5;
    this.group.add(this.sun, this.sun.target);
  }

  setShadowMapSize(size: number) {
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    (this.sun.shadow as any).map = null;
  }

  // ---------------------------------------------------------------- helpers
  private fixedBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, rotY = 0, material = 'concrete', obstacle = true) {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(cx, cy, cz)
      .setCollisionGroups(STATIC_GROUPS)
      .setFriction(0.8);
    if (rotY) desc.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY));
    const c = this.physics.world.createCollider(desc);
    this.physics.register(c, { kind: 'static', ref: null, material });
    if (obstacle && cy - hy < 1.2 && cy + hy > 0.3) {
      // use rotated bounds approximation
      const cs = Math.abs(Math.cos(rotY));
      const sn = Math.abs(Math.sin(rotY));
      this.obstacles.push({ x: cx, z: cz, hx: hx * cs + hz * sn, hz: hx * sn + hz * cs });
    }
    return c;
  }

  private fixedCylinder(cx: number, cy: number, cz: number, halfH: number, r: number, material = 'metal') {
    const c = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cylinder(halfH, r).setTranslation(cx, cy, cz).setCollisionGroups(STATIC_GROUPS),
    );
    this.physics.register(c, { kind: 'static', ref: null, material });
    if (cy - halfH < 1.2) this.obstacles.push({ x: cx, z: cz, hx: r, hz: r });
    return c;
  }

  // ---------------------------------------------------------------- building
  private buildSlab() {
    const m = this.materials;
    const W = ROOF.maxX - ROOF.minX;
    const D = ROOF.maxZ - ROOF.minZ;
    this.batch.add('roof', m.roof, tiledBox(W, 0.5, D, 3.2), mat(0, -0.25, 0), { color: 0xffffff, cast: false });
    // facade down to the street
    const facade = new THREE.Mesh(new THREE.BoxGeometry(W + 0.4, 119.4, D + 0.4), this.facadeMaterial);
    facade.position.set(0, -60.1, 0);
    facade.receiveShadow = false;
    facade.castShadow = false;
    facade.material.color.set(0xb7a79a);
    this.group.add(facade);
    // cornice ring
    const cc = 0xc9c0b8;
    this.batch.add('concrete', m.concrete, tiledBox(W + 1.0, 0.36, 0.6, 2), mat(0, -0.38, ROOF.minZ - 0.0), { color: cc });
    this.batch.add('concrete', m.concrete, tiledBox(W + 1.0, 0.36, 0.6, 2), mat(0, -0.38, ROOF.maxZ + 0.0), { color: cc });
    this.batch.add('concrete', m.concrete, tiledBox(0.6, 0.36, D + 1.0, 2), mat(ROOF.minX, -0.38, 0), { color: cc });
    this.batch.add('concrete', m.concrete, tiledBox(0.6, 0.36, D + 1.0, 2), mat(ROOF.maxX, -0.38, 0), { color: cc });
    // physical building block (roof slab + tower)
    this.fixedBox(0, -60, 0, W / 2, 60, D / 2, 0, 'roof', false);
    // the street far below, so bodies land somewhere
    this.fixedBox(0, -121, 0, 600, 1, 600, 0, 'concrete', false);
  }

  private buildParapets() {
    const m = this.materials;
    const H = PARAPET_H;
    const T = PARAPET_T;
    const { minX, maxX, minZ, maxZ } = ROOF;
    type Interval = [number, number, EdgeKind];
    const sides: { axis: 'x' | 'z'; fixed: number; n: [number, number]; from: number; to: number; intervals: Interval[] }[] = [
      { axis: 'x', fixed: minZ, n: [0, -1], from: minX, to: maxX, intervals: [[-3.6, 1.1, 'gap']] },
      { axis: 'x', fixed: maxZ, n: [0, 1], from: minX, to: maxX, intervals: [[-9.5, -3.5, 'railing'], [2.6, 6.6, 'gap']] },
      { axis: 'z', fixed: maxX, n: [1, 0], from: minZ + T, to: maxZ - T, intervals: [[-1.9, 1.9, 'plank']] },
      { axis: 'z', fixed: minX, n: [-1, 0], from: minZ + T, to: maxZ - T, intervals: [] },
    ];
    const parapetColor = 0xd9cfc4;
    const capColor = 0xa49b92;
    for (const s of sides) {
      // split [from,to] into closed (parapet) and open intervals
      const cuts = [...s.intervals].sort((a, b) => a[0] - b[0]);
      let cursor = s.from;
      const segments: Interval[] = [];
      for (const c of cuts) {
        if (c[0] > cursor) segments.push([cursor, c[0], 'parapet']);
        segments.push(c);
        cursor = c[1];
      }
      if (cursor < s.to) segments.push([cursor, s.to, 'parapet']);

      for (const [a, b, kind] of segments) {
        const len = b - a;
        const mid = (a + b) / 2;
        const inward = s.n[0] !== 0 ? -s.n[0] : -s.n[1];
        const off = s.fixed + inward * (T / 2);
        const cx = s.axis === 'x' ? mid : off;
        const cz = s.axis === 'x' ? off : mid;
        const zone: EdgeZone = {
          ax: s.axis === 'x' ? a : s.fixed,
          az: s.axis === 'x' ? s.fixed : a,
          bx: s.axis === 'x' ? b : s.fixed,
          bz: s.axis === 'x' ? s.fixed : b,
          nx: s.n[0],
          nz: s.n[1],
          kind,
        };
        if (kind === 'parapet') {
          const w = s.axis === 'x' ? len : T;
          const d = s.axis === 'x' ? T : len;
          this.batch.add('concrete', m.concrete, tiledBox(w, H, d, 1.5), mat(cx, H / 2, cz), { color: parapetColor });
          this.batch.add('concrete', m.concrete, tiledBox(w + 0.08, 0.07, d + 0.08, 1.5), mat(cx, H + 0.035, cz), { color: capColor });
          this.fixedBox(cx, H / 2, cz, w / 2, H / 2, d / 2, 0, 'concrete', false);
        } else if (kind === 'railing') {
          const n = Math.round(len / 1.5);
          const segLen = len / n;
          for (let i = 0; i < n; i++) {
            const c = a + segLen * (i + 0.5);
            const pos = s.axis === 'x' ? new THREE.Vector3(c, 0.525, off) : new THREE.Vector3(off, 0.525, c);
            const r = new RailingSegment(this.physics, pos, segLen - 0.04, s.axis, m);
            this.group.add(r.mesh);
            this.railings.push(r);
            this.edges.push({
              ...zone,
              ax: s.axis === 'x' ? c - segLen / 2 : zone.ax,
              bx: s.axis === 'x' ? c + segLen / 2 : zone.bx,
              az: s.axis === 'z' ? c - segLen / 2 : zone.az,
              bz: s.axis === 'z' ? c + segLen / 2 : zone.bz,
              railing: r,
            });
          }
          // small curb under the railing
          const w = s.axis === 'x' ? len : 0.25;
          const d = s.axis === 'x' ? 0.25 : len;
          this.batch.add('concrete', m.concrete, tiledBox(w, 0.08, d, 1.5), mat(cx, 0.04, s.axis === 'x' ? s.fixed + inward * 0.12 : cz), { color: capColor });
          continue;
        } else {
          // open edge: hazard stripes + broken stubs
          const w = s.axis === 'x' ? len : 0.5;
          const d = s.axis === 'x' ? 0.5 : len;
          const hx = s.axis === 'x' ? cx : s.fixed + inward * 0.25;
          const hz = s.axis === 'x' ? s.fixed + inward * 0.25 : cz;
          this.batch.add('hazard', m.hazard, tiledBox(w, 0.012, d, 0.6), mat(hx, 0.006, hz), { cast: false });
          if (kind === 'gap') this.addRubble(s.axis, a, b, off, H);
        }
        this.edges.push(zone);
      }
    }
  }

  private addRubble(axis: 'x' | 'z', a: number, b: number, off: number, H: number) {
    const m = this.materials;
    for (const end of [a, b]) {
      for (let i = 0; i < 4; i++) {
        const s = 0.12 + Math.random() * 0.18;
        const along = end + (end === a ? 1 : -1) * (Math.random() * 0.5 - 0.15);
        const x = axis === 'x' ? along : off + (Math.random() - 0.5) * 0.4;
        const z = axis === 'x' ? off + (Math.random() - 0.5) * 0.4 : along;
        this.batch.add('concrete', m.concrete, tiledBox(s, s * 0.7, s * 1.2, 1), mat(x, s * 0.3, z, Math.random(), Math.random() * 3, Math.random()), {
          color: 0xcfc4b8,
        });
      }
      // jagged broken end on top of the parapet stub
      const x = axis === 'x' ? end : off;
      const z = axis === 'x' ? off : end;
      this.batch.add('concrete', m.concrete, tiledBox(0.3, 0.25, 0.42, 1), mat(x, H - 0.05, z, 0.3, 0.2, 0.5), { color: 0xd9cfc4 });
      // rebar
      const rebar = new THREE.CylinderGeometry(0.012, 0.012, 0.7, 5);
      for (let k = 0; k < 3; k++) {
        this.batch.add('metal', m.metal, rebar, mat(x + (Math.random() - 0.5) * 0.2, H * 0.6, z + (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 1.2, 0, (Math.random() - 0.5) * 1.2), {
          color: 0x7a4a32,
        });
      }
    }
  }

  private buildStairHouse(cx: number, cz: number) {
    const m = this.materials;
    const w = 4;
    const d = 3.4;
    const h = 3.2;
    this.batch.add('concrete', m.concrete, tiledBox(w, h, d, 2), mat(cx, h / 2, cz), { color: 0xd8cabb });
    this.batch.add('concrete', m.concrete, tiledBox(w + 0.2, 0.15, d + 0.2, 2), mat(cx, h + 0.075, cz), { color: 0x9a918a });
    this.fixedBox(cx, h / 2, cz, w / 2, h / 2, d / 2, 0, 'concrete');
    // door on the east face
    const doorX = cx + w / 2 + 0.02;
    this.batch.add('metal', m.metal, roundedBox(0.06, 2.1, 1.1, 0.02), mat(doorX, 1.05, cz), { color: 0x2f6e5a });
    this.batch.add('metal', m.metal, new THREE.BoxGeometry(0.08, 0.06, 0.18), mat(doorX + 0.04, 1.0, cz - 0.38), { color: 0xd7d7d7 });
    // exit sign
    this.batch.add('emissive', m.emissive, new THREE.BoxGeometry(0.05, 0.22, 0.6), mat(doorX + 0.03, 2.45, cz), { color: 0x22ff88, cast: false });
    // wall lamp
    this.batch.add('emissive', m.emissive, new THREE.SphereGeometry(0.1, 10, 8), mat(doorX + 0.12, 2.25, cz + 0.85), { color: 0xffd9a0, cast: false });

    // water tower on top
    const tx = cx - 0.3;
    const tz = cz - 0.2;
    const base = h + 0.15;
    const legH = 1.7;
    const leg = new THREE.CylinderGeometry(0.07, 0.09, legH, 6);
    for (const [lx, lz] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) {
      this.batch.add('metal', m.metal, leg, mat(tx + lx, base + legH / 2, tz + lz), { color: 0x3b3d44 });
    }
    // cross braces
    const brace = new THREE.CylinderGeometry(0.03, 0.03, 2.4, 5);
    this.batch.add('metal', m.metal, brace, mat(tx, base + legH / 2, tz - 0.9, 0, 0, 0.78), { color: 0x3b3d44 });
    this.batch.add('metal', m.metal, brace, mat(tx, base + legH / 2, tz + 0.9, 0, 0, -0.78), { color: 0x3b3d44 });
    const tankY = base + legH;
    const tank = new THREE.CylinderGeometry(1.35, 1.35, 2.5, 22, 1, true);
    this.batch.add('wood', m.wood, tank, mat(tx, tankY + 1.25, tz), { color: 0xc89d72 });
    this.batch.add('wood', m.wood, new THREE.CircleGeometry(1.35, 22), mat(tx, tankY + 0.01, tz, Math.PI / 2), { color: 0x8a6a4a });
    this.batch.add('wood', m.wood, new THREE.ConeGeometry(1.5, 1.0, 22), mat(tx, tankY + 3.0, tz), { color: 0x8c6a4e });
    const band = new THREE.TorusGeometry(1.37, 0.035, 5, 28);
    for (const y of [0.35, 1.2, 2.1]) this.batch.add('metal', m.metal, band, mat(tx, tankY + y, tz, Math.PI / 2), { color: 0x2b2b30 });
    // satellite dish
    const dish = new THREE.SphereGeometry(0.55, 16, 8, 0, Math.PI * 2, 0, 0.9);
    this.batch.add('plastic', m.plastic, dish, mat(cx + 1.4, h + 0.9, cz + 1.2, -1.1, 0.6, 0), { color: 0xe9e9ee });
    this.batch.add('metal', m.metal, new THREE.CylinderGeometry(0.04, 0.04, 0.8, 6), mat(cx + 1.45, h + 0.5, cz + 1.25), { color: 0x777777 });
    // antenna mast with blinking beacon
    this.batch.add('metal', m.metal, new THREE.CylinderGeometry(0.03, 0.06, 4.5, 6), mat(cx - 1.5, h + 2.3, cz + 1.2), { color: 0xc0c0c8 });
    this.beacon = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.2, 0.15) });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), this.beacon);
    beacon.position.set(cx - 1.5, h + 4.6, cz + 1.2);
    this.group.add(beacon);
    // ladder (visual)
    const railG = new THREE.CylinderGeometry(0.025, 0.025, h, 5);
    const lx = cx + 0.8;
    const lz = cz + d / 2 + 0.12;
    this.batch.add('metal', m.metal, railG, mat(lx - 0.22, h / 2, lz), { color: 0x9a9aa2 });
    this.batch.add('metal', m.metal, railG, mat(lx + 0.22, h / 2, lz), { color: 0x9a9aa2 });
    const rung = new THREE.CylinderGeometry(0.018, 0.018, 0.44, 5);
    for (let y = 0.3; y < h; y += 0.32) this.batch.add('metal', m.metal, rung, mat(lx, y, lz, 0, 0, Math.PI / 2), { color: 0x9a9aa2 });
  }

  private buildACUnit(cx: number, cz: number) {
    const m = this.materials;
    const w = 2.1;
    const h = 1.25;
    const d = 1.4;
    this.batch.add('metal', m.metal, roundedBox(w, h, d, 0.06), mat(cx, h / 2 + 0.08, cz), { color: 0xc9ccd2 });
    // feet
    this.batch.add('metal', m.metal, new THREE.BoxGeometry(w - 0.1, 0.08, 0.15), mat(cx, 0.04, cz - d / 2 + 0.15), { color: 0x44464c });
    this.batch.add('metal', m.metal, new THREE.BoxGeometry(w - 0.1, 0.08, 0.15), mat(cx, 0.04, cz + d / 2 - 0.15), { color: 0x44464c });
    // side grille slats
    for (let i = 0; i < 7; i++) {
      this.batch.add('metal', m.metal, new THREE.BoxGeometry(w - 0.4, 0.035, 0.02), mat(cx, 0.32 + i * 0.12, cz + d / 2 + 0.005), { color: 0x6c7078 });
    }
    // fan housing on top
    const top = h + 0.08;
    this.batch.add('metal', m.metal, new THREE.CylinderGeometry(0.5, 0.5, 0.12, 24, 1, true), mat(cx - 0.45, top + 0.06, cz), { color: 0x55585f });
    this.batch.add('matte', m.matte, new THREE.CircleGeometry(0.5, 24), mat(cx - 0.45, top + 0.005, cz, -Math.PI / 2), { color: 0x151518, cast: false });
    // spinning blades
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const g = new THREE.BoxGeometry(0.42, 0.015, 0.12);
      g.translate(0.22, 0, 0);
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.35, (i * Math.PI) / 2, 0, 'YXZ')));
      parts.push(g);
    }
    const blades = new THREE.Mesh(mergeGeometries(parts)!, Arena.bladeMat);
    blades.castShadow = true;
    blades.position.set(cx - 0.45, top + 0.05, cz);
    this.group.add(blades);
    this.spinners.push({ obj: blades, speed: 14 + Math.random() * 4 });
    this.fixedBox(cx, h / 2 + 0.08, cz, w / 2, h / 2 + 0.08, d / 2, 0, 'metal');
  }

  private buildPipes() {
    const m = this.materials;
    const pipe = new THREE.CylinderGeometry(0.09, 0.09, 1, 10);
    const run = (x0: number, z0: number, x1: number, z1: number, y: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const ang = Math.atan2(z1 - z0, x1 - x0);
      const g = pipe.clone();
      g.scale(1, len, 1);
      this.batch.add('metal', m.metal, g, mat((x0 + x1) / 2, y, (z0 + z1) / 2, 0, -ang, Math.PI / 2), { color: 0x9c7a52 });
      for (let t = 0.1; t < 1; t += 0.3) {
        this.batch.add('metal', m.metal, new THREE.BoxGeometry(0.1, y, 0.22), mat(x0 + (x1 - x0) * t, y / 2, z0 + (z1 - z0) * t, 0, -ang, 0), { color: 0x4a4a50 });
      }
    };
    run(5.8, -7.2, 5.8, -9.3, 0.55);
    run(5.8, -9.3, 12.3, -9.3, 0.55);
    // pipes along the north parapet are above the parapet line → no collider needed; add one thin collider
    this.fixedBox(9.05, 0.32, -9.3, 3.3, 0.32, 0.12, 0, 'metal');
  }

  private buildVent(cx: number, cz: number) {
    const m = this.materials;
    this.batch.add('metal', m.metal, new THREE.CylinderGeometry(0.28, 0.32, 0.9, 16), mat(cx, 0.45, cz), { color: 0xb8bcc4 });
    this.batch.add('metal', m.metal, new THREE.CylinderGeometry(0.42, 0.42, 0.06, 16), mat(cx, 0.03, cz), { color: 0x6c7078 });
    if (!Arena.ventHeadGeo) {
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const g = new THREE.BoxGeometry(0.03, 0.38, 0.16);
        g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * 0.28, 0, Math.sin(a) * 0.28), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a + 0.5, 0.15)), new THREE.Vector3(1, 1, 1)));
        parts.push(g.toNonIndexed());
      }
      const cap = new THREE.SphereGeometry(0.33, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
      cap.translate(0, 0.17, 0);
      parts.push(cap.toNonIndexed());
      for (const p of parts) p.deleteAttribute('uv');
      Arena.ventHeadGeo = mergeGeometries(parts)!;
    }
    const head = new THREE.Mesh(Arena.ventHeadGeo, Arena.finMat);
    head.position.set(cx, 1.08, cz);
    head.castShadow = true;
    this.group.add(head);
    this.spinners.push({ obj: head, speed: 2 + Math.random() * 2 });
    this.fixedCylinder(cx, 0.65, cz, 0.65, 0.36);
  }

  private buildChimney(cx: number, cz: number) {
    const m = this.materials;
    const h = 1.8;
    this.batch.add('brick', m.brick, tiledBox(0.95, h, 0.95, 1.0), mat(cx, h / 2, cz), { color: 0xffffff });
    this.batch.add('concrete', m.concrete, tiledBox(1.1, 0.12, 1.1, 1), mat(cx, h + 0.06, cz), { color: 0xb0a8a0 });
    this.batch.add('matte', m.matte, new THREE.CylinderGeometry(0.16, 0.16, 0.35, 10), mat(cx + 0.2, h + 0.3, cz), { color: 0x7a5040 });
    this.batch.add('matte', m.matte, new THREE.CylinderGeometry(0.13, 0.13, 0.25, 10), mat(cx - 0.22, h + 0.25, cz + 0.1), { color: 0x6e4638 });
    this.fixedBox(cx, h / 2, cz, 0.475, h / 2, 0.475, 0, 'brick');
  }

  private buildSkylight(cx: number, cz: number) {
    const m = this.materials;
    this.batch.add('concrete', m.concrete, tiledBox(2.4, 0.42, 2.4, 1.5), mat(cx, 0.21, cz), { color: 0xcfc6bc });
    const pyr = new THREE.ConeGeometry(1.55, 0.75, 4, 1);
    const glass = new THREE.Mesh(pyr, m.glass);
    glass.position.set(cx, 0.42 + 0.375, cz);
    glass.rotation.y = Math.PI / 4;
    this.group.add(glass);
    const frame = new THREE.CylinderGeometry(0.025, 0.025, 1.65, 5);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const px = cx + Math.cos(a) * 0.55;
      const pz = cz + Math.sin(a) * 0.55;
      this.batch.add('metal', m.metal, frame, mat(px, 0.8, pz, 0, -a, 1.1), { color: 0x2c2f36 });
    }
    // collider: curb + low pyramid hull
    this.fixedBox(cx, 0.21, cz, 1.2, 0.21, 1.2, 0, 'concrete');
    const pts = new Float32Array([-1.1, 0, -1.1, 1.1, 0, -1.1, 1.1, 0, 1.1, -1.1, 0, 1.1, 0, 0.75, 0]);
    const hull = RAPIER.ColliderDesc.convexHull(pts);
    if (hull) {
      const c = this.physics.world.createCollider(hull.setTranslation(cx, 0.42, cz).setCollisionGroups(STATIC_GROUPS));
      this.physics.register(c, { kind: 'static', ref: null, material: 'glass' });
    }
  }

  private buildSolarPanels() {
    const m = this.materials;
    for (let i = 0; i < 2; i++) {
      const cz = 6.4 + i * 1.9;
      const cx = 9.8;
      // frame
      for (const x of [-1.7, 0, 1.7]) {
        this.batch.add('metal', m.metal, new THREE.BoxGeometry(0.06, 0.5, 0.06), mat(cx + x, 0.25, cz + 0.45), { color: 0x8f949c });
        this.batch.add('metal', m.metal, new THREE.BoxGeometry(0.06, 0.95, 0.06), mat(cx + x, 0.47, cz - 0.45), { color: 0x8f949c });
      }
      const panel = roundedBox(3.8, 0.06, 1.25, 0.02);
      this.batch.add('metal', m.metal, panel, mat(cx, 0.72, cz, -0.42, 0, 0), { color: 0x1d2c5c });
      // cell grid lines
      for (let k = -3; k <= 3; k++) {
        this.batch.add('metal', m.metal, new THREE.BoxGeometry(0.02, 0.005, 1.2), mat(cx + k * 0.52, 0.755, cz + 0.01, -0.42, 0, 0), { color: 0xa0a8c0, cast: false });
      }
      this.fixedBox(cx, 0.55, cz, 1.9, 0.5, 0.6, 0, 'metal');
    }
  }

  private buildPartyCorner() {
    const m = this.materials;
    // BBQ kettle grill
    const bx = -10.2;
    const bz = 6.2;
    this.batch.add('metal', m.metal, new THREE.SphereGeometry(0.42, 18, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), mat(bx, 0.95, bz), { color: 0x1c1c20 });
    this.batch.add('metal', m.metal, new THREE.SphereGeometry(0.43, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.4), mat(bx + 0.35, 1.05, bz, 0, 0, -1.2), { color: 0x1c1c20 });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      this.batch.add('metal', m.metal, new THREE.CylinderGeometry(0.025, 0.025, 1.0, 5), mat(bx + Math.cos(a) * 0.25, 0.48, bz + Math.sin(a) * 0.25, Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25), {
        color: 0x2a2a30,
      });
    }
    this.batch.add('emissive', m.emissive, new THREE.CircleGeometry(0.36, 16), mat(bx, 0.97, bz, -Math.PI / 2), { color: 0xff5a1a, cast: false });
    this.fixedCylinder(bx, 0.6, bz, 0.6, 0.45);

    // string lights poles
    const poles: [number, number][] = [[-12.3, 3.0], [-12.3, 9.3], [-6.8, 9.3], [-7.0, 3.6]];
    const poleGeo = new THREE.CylinderGeometry(0.045, 0.06, 2.7, 6);
    for (const [x, z] of poles) {
      this.batch.add('metal', m.metal, poleGeo, mat(x, 1.35, z), { color: 0x2d2d33 });
      this.fixedCylinder(x, 1.35, z, 1.35, 0.07);
    }
    // catenary strings with bulbs (one instanced mesh)
    const links: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]];
    const bulbsPerLink = 14;
    const bulbGeo = new THREE.SphereGeometry(0.055, 8, 6);
    const bulbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3) });
    const bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, links.length * bulbsPerLink);
    const wire: number[] = [];
    const palette = [0xffd36b, 0xff7a9c, 0x7ad7ff, 0xa6ff7a, 0xffa94d];
    let k = 0;
    const c = new THREE.Color();
    const tmp = new THREE.Matrix4();
    for (const [ia, ib] of links) {
      const [ax, az] = poles[ia];
      const [bxx, bzz] = poles[ib];
      const y0 = 2.62;
      let prev: THREE.Vector3 | null = null;
      for (let i = 0; i <= bulbsPerLink; i++) {
        const t = i / bulbsPerLink;
        const sag = Math.sin(t * Math.PI) * 0.55;
        const p = new THREE.Vector3(ax + (bxx - ax) * t, y0 - sag, az + (bzz - az) * t);
        if (prev) wire.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        prev = p;
        if (i > 0 && i <= bulbsPerLink) {
          tmp.makeTranslation(p.x, p.y - 0.06, p.z);
          bulbs.setMatrixAt(k, tmp);
          bulbs.setColorAt(k, c.set(palette[k % palette.length]));
          k++;
        }
      }
    }
    bulbs.count = k;
    bulbs.frustumCulled = false;
    this.group.add(bulbs);
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    this.group.add(new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0x111111 })));

    // big outdoor rug & low table (visual)
    this.batch.add('matte', m.matte, new THREE.BoxGeometry(3.2, 0.015, 2.4), mat(-9.6, 0.008, 6.4), { color: 0x6b2f5c, cast: false });
    this.batch.add('matte', m.matte, new THREE.BoxGeometry(2.9, 0.017, 0.2), mat(-9.6, 0.009, 5.5), { color: 0xe7b84a, cast: false });
  }

  private buildPlank() {
    const m = this.materials;
    // walk-the-plank: a board jutting over the void on the east side
    const len = 3.4;
    const x0 = ROOF.maxX - 0.6;
    const cx = x0 + len / 2;
    this.batch.add('wood', m.wood, tiledBox(len, 0.08, 0.75, 1.2), mat(cx, 0.06, 0, 0, 0, 0), { color: 0xffffff });
    // brackets bolted to the slab edge
    this.batch.add('metal', m.metal, new THREE.BoxGeometry(0.9, 0.12, 0.85), mat(ROOF.maxX - 0.2, 0.06, 0), { color: 0x3a3a40 });
    this.batch.add('metal', m.metal, new THREE.CylinderGeometry(0.03, 0.03, 1.2, 5), mat(ROOF.maxX + 0.4, -0.3, -0.3, 0, 0, 1.0), { color: 0x3a3a40 });
    this.batch.add('metal', m.metal, new THREE.CylinderGeometry(0.03, 0.03, 1.2, 5), mat(ROOF.maxX + 0.4, -0.3, 0.3, 0, 0, 1.0), { color: 0x3a3a40 });
    const c = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(len / 2, 0.04, 0.375).setTranslation(cx, 0.06, 0).setCollisionGroups(STATIC_GROUPS),
    );
    this.physics.register(c, { kind: 'static', ref: null, material: 'wood' });
    // sign "PLONGEOIR" stuck at its root
    const signTex = textTexture('PLONGEOIR', { color: '#ffe14d', stroke: '#1a1a1a', w: 512, h: 128 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.28), new THREE.MeshStandardMaterial({ map: signTex, transparent: true, roughness: 0.6 }));
    sign.position.set(ROOF.maxX - 0.35, 1.25, -0.75);
    sign.rotation.y = -Math.PI / 2;
    this.group.add(sign);
    this.batch.add('metal', m.metal, new THREE.CylinderGeometry(0.03, 0.03, 1.2, 6), mat(ROOF.maxX - 0.33, 0.6, -0.75), { color: 0x777777 });
    this.fixedCylinder(ROOF.maxX - 0.33, 0.6, -0.75, 0.6, 0.04);
  }

  private buildBillboard() {
    const m = this.materials;
    const x = ROOF.minX - 0.5;
    const w = 9;
    const h = 2.8;
    const y0 = 1.3;
    // frame
    for (const z of [-3.6, 0, 3.6]) {
      this.batch.add('metal', m.metal, new THREE.BoxGeometry(0.14, y0 + h + 0.2, 0.14), mat(x, (y0 + h) / 2, z), { color: 0x2b2d33 });
      this.batch.add('metal', m.metal, new THREE.BoxGeometry(1.4, 0.1, 0.1), mat(x + 0.55, 0.85, z, 0, 0, -0.55), { color: 0x2b2d33 });
    }
    this.batch.add('metal', m.metal, new THREE.BoxGeometry(0.12, h + 0.2, w + 0.3), mat(x - 0.06, y0 + h / 2, 0), { color: 0x18181e });
    // catwalk lights (emissive)
    for (const z of [-3, -1, 1, 3]) {
      this.batch.add('emissive', m.emissive, new THREE.BoxGeometry(0.2, 0.06, 0.3), mat(x + 0.25, y0 - 0.05, z), { color: 0xfff0d0, cast: false });
    }
    const tex = textTexture('BASTOS', { color: '#ffd1f2', glow: '#ff2fa8', w: 1024, h: 256 });
    this.neonMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, color: new THREE.Color(2.6, 1.4, 2.4), depthWrite: false });
    const neon = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.95, h * 0.62), this.neonMat);
    neon.position.set(x + 0.03, y0 + h * 0.6, 0);
    neon.rotation.y = Math.PI / 2;
    this.group.add(neon);
    const sub = textTexture('— TOWER —', { color: '#c9f6ff', glow: '#1fd1ff', w: 1024, h: 160 });
    const subMesh = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.6, 0.55), new THREE.MeshBasicMaterial({ map: sub, transparent: true, color: new THREE.Color(1.5, 2.4, 2.8), depthWrite: false }));
    subMesh.position.set(x + 0.03, y0 + 0.42, 0);
    subMesh.rotation.y = Math.PI / 2;
    this.group.add(subMesh);
    this.neonLight = new THREE.PointLight(0xff4fc0, 18, 15, 1.6);
    this.neonLight.position.set(x + 1.6, y0 + h * 0.6, 0);
    this.group.add(this.neonLight);
    // posts are on the parapet line: give them colliders
    for (const z of [-3.6, 0, 3.6]) this.fixedBox(x, (y0 + h) / 2, z, 0.07, (y0 + h) / 2, 0.07, 0, 'metal', false);
  }

  private buildMarkings() {
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(8.2, 8.2),
      new THREE.MeshStandardMaterial({
        map: helipadTexture(),
        transparent: true,
        roughness: 0.8,
        color: 0xfff6e8,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        depthWrite: false,
      }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(0, 0.004, 0.4);
    pad.receiveShadow = true;
    this.group.add(pad);
    // reflective puddles (one merged mesh)
    const puddles: THREE.BufferGeometry[] = [];
    for (const [x, z, s] of [[-3.5, 3.2, 1.2], [7.4, -3.2, 0.9], [-7.4, -1.6, 1.4], [2.4, -6.4, 0.8]] as const) {
      const g = new THREE.CircleGeometry(s, 20);
      g.scale(1, 0.6 + Math.random() * 0.3, 1);
      g.rotateX(-Math.PI / 2);
      g.translate(x, 0.006, z);
      puddles.push(g);
    }
    const pm = new THREE.Mesh(mergeGeometries(puddles)!, this.materials.puddle);
    pm.receiveShadow = true;
    this.group.add(pm);
  }

  // ---------------------------------------------------------------- runtime
  update(dt: number, time: number) {
    for (const s of this.spinners) s.obj.rotation.y += s.speed * dt;
    for (const r of this.railings) r.sync();
    // neon flicker: mostly stable, occasional stutter
    this.neonFlicker -= dt;
    let k = 1;
    if (this.neonFlicker < 0) {
      if (Math.random() < 0.02) this.neonFlicker = 0.25 + Math.random() * 0.4;
    } else {
      k = Math.random() < 0.5 ? 0.25 : 1;
    }
    this.neonMat.color.setRGB(2.6 * k, 1.4 * k, 2.4 * k);
    this.neonLight.intensity = 18 * k;
    const blink = Math.sin(time * 3.1) > 0.6 ? 4 : 0.15;
    this.beacon.color.setRGB(blink, 0.1 * blink, 0.08 * blink);
  }

  reset() {
    for (const r of this.railings) r.reset();
  }

  // ---------------------------------------------------------------- queries
  isInsideRoof(x: number, z: number, margin = 0) {
    return x > ROOF.minX + margin && x < ROOF.maxX - margin && z > ROOF.minZ + margin && z < ROOF.maxZ - margin;
  }

  /** Is this position over the plank (still "on the roof" but above the void)? */
  isOnPlank(x: number, z: number) {
    return x >= ROOF.maxX - 0.6 && x <= ROOF.maxX + 2.8 && Math.abs(z) <= 0.45;
  }

  /** Distance from (x,z) to the closest edge that lets you fall (gap, plank, broken railing). */
  distanceToOpenEdge(x: number, z: number, out?: { edge: EdgeZone | null; px: number; pz: number }) {
    let best = Infinity;
    let bestE: EdgeZone | null = null;
    let bpx = 0;
    let bpz = 0;
    for (const e of this.edges) {
      const open = e.kind === 'gap' || e.kind === 'plank' || (e.kind === 'railing' && e.railing?.broken);
      if (!open) continue;
      const [d, px, pz] = pointSegDist(x, z, e.ax, e.az, e.bx, e.bz);
      if (d < best) {
        best = d;
        bestE = e;
        bpx = px;
        bpz = pz;
      }
    }
    if (out) {
      out.edge = bestE;
      out.px = bpx;
      out.pz = bpz;
    }
    return best;
  }

  /** Distance from (x,z) to the roof boundary of any kind. */
  distanceToAnyEdge(x: number, z: number) {
    return Math.min(x - ROOF.minX, ROOF.maxX - x, z - ROOF.minZ, ROOF.maxZ - z);
  }

  /**
   * Best spot to dump a carried body over the side: returns a point ~1.4 m
   * inside the roof in front of an edge, and the outward direction to throw.
   */
  bestThrowSpot(x: number, z: number) {
    let best = Infinity;
    let res = { x: 0, z: 0, nx: 0, nz: -1, kind: 'gap' as EdgeKind };
    for (const e of this.edges) {
      const open = e.kind === 'gap' || e.kind === 'plank' || e.kind === 'railing';
      const len = Math.hypot(e.bx - e.ax, e.bz - e.az);
      const mx = (e.ax + e.bx) / 2 - e.nx * 1.5;
      const mz = (e.az + e.bz) / 2 - e.nz * 1.5;
      // parapets work too, but open edges are preferred
      const penalty = open ? (e.kind === 'railing' && !e.railing?.broken ? 3 : 0) : 6 + Math.max(0, 3 - len);
      const d = Math.hypot(mx - x, mz - z) + penalty;
      if (d < best) {
        best = d;
        res = { x: clamp(mx, ROOF.minX + 1, ROOF.maxX - 1), z: clamp(mz, ROOF.minZ + 1, ROOF.maxZ - 1), nx: e.nx, nz: e.nz, kind: e.kind };
      }
    }
    return res;
  }

  /** True if the segment from a to b on the XZ plane is blocked by a low static obstacle. */
  blockedXZ(ax: number, az: number, bx: number, bz: number, pad = 0.4) {
    for (const o of this.obstacles) {
      if (segIntersectsAABB(ax, az, bx, bz, o.x - o.hx - pad, o.z - o.hz - pad, o.x + o.hx + pad, o.z + o.hz + pad)) return true;
    }
    return false;
  }
}

export function pointSegDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): [number, number, number] {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  return [Math.hypot(px - cx, pz - cz), cx, cz];
}

function segIntersectsAABB(ax: number, az: number, bx: number, bz: number, minX: number, minZ: number, maxX: number, maxZ: number) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax - minX) && clip(dx, maxX - ax) && clip(-dz, az - minZ) && clip(dz, maxZ - az);
}
