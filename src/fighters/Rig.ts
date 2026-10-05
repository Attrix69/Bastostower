import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CharacterLook } from './Characters';

/**
 * Procedural character rig.
 *
 * The whole body is ONE SkinnedMesh with rigid skinning (each vertex bound to
 * a single bone) → 1 draw call per fighter, shadows included. Parts are built
 * from rounded primitives with baked vertex colors for a clean cartoon look.
 *
 * Bind pose: standing, arms hanging, every bone local rotation = identity.
 * Limb bones point down their local -Y; the character faces -Z.
 */

export const BONE_NAMES = [
  'root',
  'pelvis',
  'chest',
  'head',
  'upperArmL',
  'foreArmL',
  'handL',
  'upperArmR',
  'foreArmR',
  'handR',
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
  'pupilL',
  'pupilR',
  'lidL',
  'lidR',
  'mouth',
  'browL',
  'browR',
  'koEyes',
] as const;
export type BoneName = (typeof BONE_NAMES)[number];
export const B = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i])) as Record<BoneName, number>;

const PARENT: Record<BoneName, BoneName | null> = {
  root: null,
  pelvis: 'root',
  chest: 'pelvis',
  head: 'chest',
  upperArmL: 'chest',
  foreArmL: 'upperArmL',
  handL: 'foreArmL',
  upperArmR: 'chest',
  foreArmR: 'upperArmR',
  handR: 'foreArmR',
  thighL: 'pelvis',
  shinL: 'thighL',
  footL: 'shinL',
  thighR: 'pelvis',
  shinR: 'thighR',
  footR: 'shinR',
  pupilL: 'head',
  pupilR: 'head',
  lidL: 'head',
  lidR: 'head',
  mouth: 'head',
  browL: 'head',
  browR: 'head',
  koEyes: 'head',
};

export interface RigDims {
  pelvisY: number;
  spine: number;
  neck: number;
  headR: number;
  headCY: number;
  shoulderX: number;
  shoulderY: number;
  upperArm: number;
  foreArm: number;
  fistR: number;
  hipX: number;
  hipY: number;
  thigh: number;
  shin: number;
  ankle: number;
  torsoW: number;
  torsoD: number;
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  eyeR: number;
  /** eye height above the feet in bind pose */
  eyeHeight: number;
}

export function computeDims(look: CharacterLook): RigDims {
  const h = look.height;
  const w = look.bodyW;
  const hs = look.headScale;
  const pelvisY = 0.93 * h;
  const hipY = -0.05;
  const thigh = 0.42 * h;
  const shin = 0.4 * h;
  const spine = 0.27 * h;
  const neck = 0.27 * h;
  const headR = 0.215 * hs;
  const headCY = 0.19 * hs;
  return {
    pelvisY,
    spine,
    neck,
    headR,
    headCY,
    shoulderX: 0.245 * w,
    shoulderY: 0.2 * h,
    upperArm: 0.3 * h,
    foreArm: 0.28 * h,
    fistR: 0.1,
    hipX: 0.115 * w,
    hipY,
    thigh,
    shin,
    ankle: pelvisY + hipY - thigh - shin,
    torsoW: 0.46 * w,
    torsoD: 0.3 * Math.sqrt(w),
    eyeX: 0.085 * hs,
    eyeY: headCY + 0.035 * hs,
    eyeZ: -headR * 0.83,
    eyeR: 0.064 * hs,
    eyeHeight: pelvisY + spine + neck + headCY + 0.03,
  };
}

interface PartBuilder {
  geos: THREE.BufferGeometry[];
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

function T(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz));
}

export class Rig {
  readonly bones: THREE.Bone[] = [];
  readonly root: THREE.Bone;
  readonly mesh: THREE.SkinnedMesh;
  readonly dims: RigDims;
  readonly stars: THREE.Group;
  readonly material: THREE.MeshStandardMaterial;
  /** previous world positions of key bones (for velocity → ragdoll handoff) */
  readonly prevPos: THREE.Vector3[] = [];
  readonly curPos: THREE.Vector3[] = [];
  /** bind-pose local positions (constant offsets) */
  readonly bindPos: THREE.Vector3[] = [];

  constructor(readonly look: CharacterLook) {
    this.dims = computeDims(look);
    const d = this.dims;
    // --- bones
    const offsets: Record<BoneName, [number, number, number]> = {
      root: [0, 0, 0],
      pelvis: [0, d.pelvisY, 0],
      chest: [0, d.spine, 0],
      head: [0, d.neck, 0],
      upperArmL: [-d.shoulderX, d.shoulderY, 0],
      foreArmL: [0, -d.upperArm, 0],
      handL: [0, -d.foreArm, 0],
      upperArmR: [d.shoulderX, d.shoulderY, 0],
      foreArmR: [0, -d.upperArm, 0],
      handR: [0, -d.foreArm, 0],
      thighL: [-d.hipX, d.hipY, 0],
      shinL: [0, -d.thigh, 0],
      footL: [0, -d.shin, 0],
      thighR: [d.hipX, d.hipY, 0],
      shinR: [0, -d.thigh, 0],
      footR: [0, -d.shin, 0],
      pupilL: [-d.eyeX, d.eyeY, d.eyeZ],
      pupilR: [d.eyeX, d.eyeY, d.eyeZ],
      lidL: [-d.eyeX, d.eyeY, d.eyeZ],
      lidR: [d.eyeX, d.eyeY, d.eyeZ],
      mouth: [0, d.headCY - 0.095 * look.headScale, -d.headR * 0.88],
      browL: [-d.eyeX, d.eyeY + 0.085 * look.headScale, d.eyeZ - 0.035],
      browR: [d.eyeX, d.eyeY + 0.085 * look.headScale, d.eyeZ - 0.035],
      koEyes: [0, d.eyeY, d.eyeZ],
    };
    for (const name of BONE_NAMES) {
      const b = new THREE.Bone();
      b.name = name;
      const o = offsets[name];
      b.position.set(o[0], o[1], o[2]);
      this.bindPos.push(b.position.clone());
      this.bones.push(b);
      this.prevPos.push(new THREE.Vector3());
      this.curPos.push(new THREE.Vector3());
    }
    for (const name of BONE_NAMES) {
      const p = PARENT[name];
      if (p) this.bones[B[p]].add(this.bones[B[name]]);
    }
    this.root = this.bones[B.root];
    this.root.updateMatrixWorld(true);

    // --- geometry
    const geo = this.buildGeometry();
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.02 });
    this.mesh = new THREE.SkinnedMesh(geo, this.material);
    this.mesh.add(this.root);
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;

    // --- stun stars orbiting the head
    this.stars = new THREE.Group();
    const starShape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
      const r = i % 2 === 0 ? 0.07 : 0.03;
      if (i === 0) starShape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else starShape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const starGeo = new THREE.ExtrudeGeometry(starShape, { depth: 0.02, bevelEnabled: false });
    starGeo.center();
    const starMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.1, 0.4) });
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(starGeo, starMat);
      this.stars.add(s);
    }
    this.stars.position.set(0, d.headCY + d.headR + 0.12, 0);
    this.stars.visible = false;
    this.bones[B.head].add(this.stars);
  }

  bone(i: number) {
    return this.bones[i];
  }

  /** Reset every bone to bind pose. */
  resetPose() {
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      b.position.copy(this.bindPos[i]);
      b.quaternion.identity();
      b.scale.set(1, 1, 1);
    }
  }

  /** Track bone world positions for velocity estimation. Call after the pose is final. */
  trackVelocities() {
    for (let i = 0; i < 16; i++) {
      this.prevPos[i].copy(this.curPos[i]);
      this.curPos[i].setFromMatrixPosition(this.bones[i].matrixWorld);
    }
  }

  snapVelocities() {
    for (let i = 0; i < 16; i++) {
      this.curPos[i].setFromMatrixPosition(this.bones[i].matrixWorld);
      this.prevPos[i].copy(this.curPos[i]);
    }
  }

  // ------------------------------------------------------------------ geometry
  private buildGeometry() {
    const L = this.look;
    const d = this.dims;
    const parts: { geo: THREE.BufferGeometry; bone: number }[] = [];
    const bindWorld = this.bones.map((b) => b.matrixWorld.clone());
    const add = (bone: BoneName, g: THREE.BufferGeometry, color: number, m?: THREE.Matrix4) => {
      let geo = g.index ? g.toNonIndexed() : g.clone();
      for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
      if (m) geo.applyMatrix4(m);
      geo.applyMatrix4(bindWorld[B[bone]]);
      const n = geo.attributes.position.count;
      const c = new THREE.Color(color);
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push({ geo, bone: B[bone] });
      g.dispose();
    };
    const rbox = (w: number, h: number, dd: number, r: number) => new RoundedBoxGeometry(w, h, dd, 3, Math.min(r, Math.min(w, h, dd) / 2 - 0.002));
    const cap = (r: number, len: number) => new THREE.CapsuleGeometry(r, Math.max(0.001, len), 5, 12);
    const sph = (r: number, ws = 16, hs = 12) => new THREE.SphereGeometry(r, ws, hs);
    const cyl = (r1: number, r2: number, h: number, s = 12) => new THREE.CylinderGeometry(r1, r2, h, s);

    const sleeveColor = L.outfit === 'tank' ? L.skin : L.shirt;
    const longSleeves = L.outfit === 'tracksuit' || L.outfit === 'hoodie' || L.outfit === 'cardigan';
    const forearmColor = longSleeves ? L.shirt : L.skin;
    const armR = 0.068 * Math.sqrt(L.bodyW);

    // ---------------- pelvis
    add('pelvis', rbox(d.torsoW * 0.94, 0.28, d.torsoD * 0.96, 0.09), L.pants, T(0, -0.03, 0));
    add('pelvis', rbox(d.torsoW * 0.96, 0.05, d.torsoD * 0.98, 0.02), L.outfit === 'overalls' ? L.pants : 0x2a2420, T(0, 0.09, 0));
    if (L.outfit !== 'overalls') add('pelvis', rbox(0.07, 0.05, 0.02, 0.01), 0xd4af37, T(0, 0.09, -d.torsoD * 0.49));

    // ---------------- chest / torso
    const torsoH = 0.5;
    add('chest', rbox(d.torsoW, torsoH, d.torsoD, 0.12), L.shirt, T(0, 0.06, 0));
    if (L.belly > 0.05) {
      const br = 0.12 + 0.12 * L.belly;
      add('chest', sph(br, 18, 14), L.outfit === 'tank' && L.belly > 0.8 ? L.shirt : L.shirt, T(0, -0.04, -d.torsoD * 0.2, 0, 0, 0, 1.15, 1, 1));
      if (L.outfit === 'tank') add('chest', sph(br * 0.98, 14, 10), L.skin, T(0, -0.14, -d.torsoD * 0.22, 0, 0, 0, 1.05, 0.55, 0.95));
    }
    // shoulders
    for (const s of [-1, 1]) add('chest', sph(0.092, 14, 10), sleeveColor, T(s * d.shoulderX, d.shoulderY, 0));
    // neck
    add('chest', cyl(0.075, 0.09, 0.14), L.skin, T(0, d.neck - 0.03, 0));
    // outfit details
    if (L.outfit === 'tank') {
      add('chest', rbox(d.torsoW * 0.6, 0.12, 0.02, 0.01), L.skin, T(0, 0.3, -d.torsoD * 0.48));
      add('chest', rbox(d.torsoW * 0.6, 0.12, 0.02, 0.01), L.skin, T(0, 0.3, d.torsoD * 0.48));
      add('chest', rbox(d.torsoW * 0.5, 0.04, 0.02, 0.01), L.shirtAccent, T(0, 0.0, -d.torsoD * 0.5));
    } else if (L.outfit === 'hoodie') {
      add('chest', new THREE.TorusGeometry(0.15, 0.06, 8, 16, Math.PI), L.shirt, T(0, 0.3, d.torsoD * 0.35, -0.4, 0, 0));
      add('chest', rbox(d.torsoW * 0.62, 0.16, 0.04, 0.03), L.shirt, T(0, -0.1, -d.torsoD * 0.5));
      add('chest', cyl(0.008, 0.008, 0.16, 5), L.shirtAccent, T(-0.05, 0.2, -d.torsoD * 0.52));
      add('chest', cyl(0.008, 0.008, 0.16, 5), L.shirtAccent, T(0.05, 0.2, -d.torsoD * 0.52));
      add('chest', rbox(0.12, 0.06, 0.02, 0.01), L.shirtAccent, T(0, 0.12, -d.torsoD * 0.51));
    } else if (L.outfit === 'tracksuit') {
      add('chest', rbox(0.03, torsoH * 0.9, 0.02, 0.01), L.shirtAccent, T(0, 0.06, -d.torsoD * 0.505));
      add('chest', rbox(0.1, 0.07, 0.03, 0.02), L.shirtAccent, T(0, 0.3, -d.torsoD * 0.45));
    } else if (L.outfit === 'cardigan') {
      for (let i = 0; i < 4; i++) add('chest', sph(0.018, 8, 6), L.shirtAccent, T(0, 0.22 - i * 0.1, -d.torsoD * 0.5));
      add('chest', rbox(d.torsoW * 0.5, 0.1, 0.02, 0.01), L.shirtAccent, T(0, 0.28, -d.torsoD * 0.49));
    } else if (L.outfit === 'overalls') {
      add('chest', rbox(d.torsoW * 0.62, 0.3, 0.03, 0.02), L.pants, T(0, -0.02, -d.torsoD * 0.5));
      add('chest', rbox(0.07, 0.04, 0.02, 0.01), 0xd8d8d8, T(0, 0.08, -d.torsoD * 0.52));
      for (const s of [-1, 1]) {
        add('chest', rbox(0.05, 0.42, 0.02, 0.01), L.pants, T(s * 0.11, 0.12, -d.torsoD * 0.505, 0, 0, s * 0.1));
        add('chest', rbox(0.05, 0.42, 0.02, 0.01), L.pants, T(s * 0.11, 0.12, d.torsoD * 0.505, 0, 0, -s * 0.1));
      }
      add('chest', rbox(0.1, 0.08, 0.02, 0.01), L.shirtAccent, T(0.07, 0.05, -d.torsoD * 0.52));
    }

    // ---------------- head
    const hr = d.headR;
    const hc = d.headCY;
    add('head', sph(hr, 28, 20), L.skin, T(0, hc, 0, 0, 0, 0, 1, 1.04, 1));
    // jaw / chin
    add('head', sph(hr * 0.78, 18, 12), L.skin, T(0, hc - hr * 0.42, -hr * 0.2, 0, 0, 0, 1, 0.75, 1));
    // ears
    for (const s of [-1, 1]) add('head', sph(0.055, 10, 8), L.skin, T(s * hr * 0.98, hc, 0.01, 0, 0, 0, 0.55, 1, 0.8));
    // nose
    add('head', sph(0.055 * L.nose, 14, 10), new THREE.Color(L.skin).offsetHSL(0, 0.05, -0.06).getHex(), T(0, d.eyeY - 0.06, d.eyeZ - 0.06 * L.nose, 0, 0, 0, 1, 0.9, 1.1));
    // eye whites
    for (const s of [-1, 1]) add('head', sph(d.eyeR, 16, 12), 0xffffff, T(s * d.eyeX, d.eyeY, d.eyeZ, 0, 0, 0, 1, 1.15, 0.85));
    // hair / hats
    if (L.hat === 'hair') {
      add('head', sph(hr * 1.04, 20, 12, ), L.hair, T(0, hc + hr * 0.18, hr * 0.08, 0, 0, 0, 1, 0.82, 1));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        add('head', sph(hr * 0.32, 10, 8), L.hair, T(Math.cos(a) * hr * 0.55, hc + hr * 0.82, Math.sin(a) * hr * 0.5 + 0.02));
      }
      add('head', sph(hr * 0.4, 10, 8), L.hair, T(0.05, hc + hr * 0.62, -hr * 0.72, 0.3, 0, 0, 1.4, 0.6, 0.7));
    } else if (L.hat === 'cap') {
      add('head', sph(hr * 1.05, 20, 10), L.hatColor, T(0, hc + hr * 0.32, 0.01, 0, 0, 0, 1, 0.68, 1));
      add('head', rbox(hr * 1.2, 0.025, hr * 0.9, 0.012), L.hatColor, T(0, hc + hr * 0.5, hr * 1.1, 0.25, 0, 0)); // visor on the back
      add('head', sph(0.025, 8, 6), 0xffffff, T(0, hc + hr * 1.0, 0));
      add('head', sph(hr * 0.9, 12, 8), L.hair, T(0, hc - hr * 0.15, hr * 0.35, 0, 0, 0, 1.05, 0.6, 0.8));
    } else if (L.hat === 'beanie') {
      add('head', sph(hr * 1.07, 20, 12), L.hatColor, T(0, hc + hr * 0.25, 0.01, 0, 0, 0, 1, 0.85, 1));
      add('head', new THREE.TorusGeometry(hr * 0.98, 0.04, 8, 22), new THREE.Color(L.hatColor).offsetHSL(0, 0, -0.08).getHex(), T(0, hc + hr * 0.38, 0, Math.PI / 2));
      add('head', sph(0.07, 10, 8), 0xffffff, T(0, hc + hr * 1.18, 0));
    } else if (L.hat === 'bun') {
      add('head', sph(hr * 1.05, 20, 12), L.hair, T(0, hc + hr * 0.2, hr * 0.08, 0, 0, 0, 1, 0.85, 1.02));
      add('head', sph(hr * 0.45, 14, 10), L.hair, T(0, hc + hr * 1.05, hr * 0.25));
      add('head', new THREE.TorusGeometry(hr * 0.3, 0.015, 6, 14), 0xe77fb3, T(0, hc + hr * 0.82, hr * 0.2, Math.PI / 2 - 0.3));
    } else if (L.hat === 'none') {
      // bald with a horseshoe fringe
      add('head', new THREE.TorusGeometry(hr * 0.9, 0.05, 8, 20, Math.PI * 1.1), L.hair, T(0, hc + 0.0, 0.02, Math.PI / 2, 0, Math.PI * -0.05 + Math.PI));
    }
    if (L.facial === 'mustache') {
      for (const s of [-1, 1]) add('head', sph(0.06, 12, 8), L.hair, T(s * 0.055, d.eyeY - 0.11, d.eyeZ - 0.03, 0, 0, s * -0.35, 1.5, 0.55, 0.7));
    } else if (L.facial === 'beard') {
      add('head', sph(hr * 0.8, 18, 12), L.hair, T(0, hc - hr * 0.55, -hr * 0.25, 0, 0, 0, 1.05, 0.85, 0.9));
      for (const s of [-1, 1]) add('head', sph(0.05, 10, 8), L.hair, T(s * 0.05, d.eyeY - 0.105, d.eyeZ - 0.035, 0, 0, s * -0.3, 1.4, 0.5, 0.7));
    }
    if (L.glasses) {
      for (const s of [-1, 1]) add('head', new THREE.TorusGeometry(d.eyeR * 1.05, 0.009, 6, 18), 0x222222, T(s * d.eyeX, d.eyeY, d.eyeZ - 0.06));
      add('head', cyl(0.007, 0.007, 0.05, 5), 0x222222, T(0, d.eyeY, d.eyeZ - 0.06, 0, 0, Math.PI / 2));
    }

    // ---------------- face (animated bones)
    for (const s of ['L', 'R'] as const) {
      add(`pupil${s}`, sph(0.03, 12, 8), 0x101014, T(0, 0, -d.eyeR * 0.78, 0, 0, 0, 1, 1.15, 0.5));
      add(`pupil${s}`, sph(0.009, 6, 4), 0xffffff, T(0.01, 0.012, -d.eyeR * 0.78 - 0.016));
      add(`lid${s}`, sph(d.eyeR * 1.08, 16, 10), L.skin, T(0, 0, 0, 0, 0, 0, 1, 1.15, 0.9));
      add(`brow${s}`, rbox(0.1, 0.028, 0.03, 0.012), L.hat === 'none' && L.facial === 'mustache' ? L.hair : L.hair, T());
    }
    add('mouth', sph(0.05, 14, 10), 0x5a1216, T(0, 0, 0, 0, 0, 0, 1.45, 1, 0.55));
    add('mouth', rbox(0.1, 0.022, 0.03, 0.008), 0xffffff, T(0, 0.03, -0.012));
    add('mouth', sph(0.03, 10, 6), 0xe0606a, T(0, -0.026, -0.012, 0, 0, 0, 1.3, 0.6, 0.8));
    for (const s of [-1, 1]) {
      add('koEyes', rbox(0.1, 0.02, 0.02, 0.008), 0x101014, T(s * d.eyeX, 0, -d.eyeR * 0.85, 0, 0, Math.PI / 4));
      add('koEyes', rbox(0.1, 0.02, 0.02, 0.008), 0x101014, T(s * d.eyeX, 0, -d.eyeR * 0.85, 0, 0, -Math.PI / 4));
    }

    // ---------------- arms
    for (const s of ['L', 'R'] as const) {
      add(`upperArm${s}`, cap(armR, d.upperArm * 0.9), sleeveColor, T(0, -d.upperArm / 2, 0));
      add(`foreArm${s}`, cap(armR * 0.88, d.foreArm * 0.85), forearmColor, T(0, -d.foreArm / 2, 0));
      if (longSleeves) add(`foreArm${s}`, cyl(armR * 1.02, armR * 1.02, 0.05, 12), L.outfit === 'tracksuit' ? L.shirtAccent : L.shirt, T(0, -d.foreArm + 0.06, 0));
      if (L.outfit === 'tracksuit') add(`upperArm${s}`, rbox(0.02, d.upperArm * 0.8, 0.02, 0.008), L.shirtAccent, T(s === 'L' ? -armR : armR, -d.upperArm / 2, 0));
      // big cartoon fist / glove
      add(`hand${s}`, rbox(0.165, 0.15, 0.175, 0.06), L.gloves, T(0, -0.075, -0.005));
      add(`hand${s}`, rbox(0.12, 0.05, 0.13, 0.02), new THREE.Color(L.gloves).offsetHSL(0, 0, 0.12).getHex(), T(0, 0.005, 0));
      add(`hand${s}`, sph(0.04, 10, 8), L.gloves, T(s === 'L' ? 0.07 : -0.07, -0.06, -0.06));
    }

    // ---------------- legs
    const legR = 0.088 * Math.sqrt(L.bodyW);
    for (const s of ['L', 'R'] as const) {
      add(`thigh${s}`, cap(legR, d.thigh * 0.85), L.pants, T(0, -d.thigh / 2, 0));
      add(`shin${s}`, cap(legR * 0.85, d.shin * 0.85), L.pants, T(0, -d.shin / 2, 0));
      if (L.outfit === 'tracksuit') {
        add(`thigh${s}`, rbox(0.02, d.thigh * 0.8, 0.02, 0.008), L.shirtAccent, T(s === 'L' ? -legR : legR, -d.thigh / 2, 0));
        add(`shin${s}`, rbox(0.02, d.shin * 0.8, 0.02, 0.008), L.shirtAccent, T(s === 'L' ? -legR * 0.85 : legR * 0.85, -d.shin / 2, 0));
      }
      // shoe
      add(`foot${s}`, rbox(0.14, 0.11, 0.29, 0.05), L.shoes, T(0, -d.ankle + 0.06, -0.06));
      add(`foot${s}`, rbox(0.145, 0.03, 0.3, 0.012), 0xeeeeee, T(0, -d.ankle + 0.015, -0.06));
    }

    // --- merge with rigid skin weights
    let count = 0;
    for (const p of parts) count += p.geo.attributes.position.count;
    const pos = new Float32Array(count * 3);
    const nor = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const si = new Uint16Array(count * 4);
    const sw = new Float32Array(count * 4);
    let o = 0;
    for (const p of parts) {
      const n = p.geo.attributes.position.count;
      pos.set(p.geo.attributes.position.array as Float32Array, o * 3);
      nor.set(p.geo.attributes.normal.array as Float32Array, o * 3);
      col.set(p.geo.attributes.color.array as Float32Array, o * 3);
      for (let i = 0; i < n; i++) {
        si[(o + i) * 4] = p.bone;
        sw[(o + i) * 4] = 1;
      }
      o += n;
      p.geo.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    g.computeBoundingSphere();
    return g;
  }
}

export type { PartBuilder };
