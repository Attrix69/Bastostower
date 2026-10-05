import * as THREE from 'three';
import { mat, merge, part, roundedBox } from '../world/geo';

/**
 * Catalog of interactive rooftop props. Every prop is modelled procedurally
 * (merged primitives with baked vertex colors → one instanced draw call per type).
 *
 * Conventions: local origin = collider center. One-handed weapons have their
 * handle toward -Y (grip point) and extend along +Y.
 */

export type PropCategory = 'light' | 'heavy' | 'blunt' | 'fun';
export type PropSound = 'plastic' | 'cardboard' | 'wood' | 'metal' | 'pan' | 'squeak' | 'soft' | 'ceramic' | 'bread' | 'melon' | 'rubber' | 'stone' | 'gas';
export type PropSpecial = 'explode' | 'break' | 'splat' | 'squeak' | 'float' | 'bouncy' | 'crumble';

export type PropShape =
  | { type: 'box'; hx: number; hy: number; hz: number }
  | { type: 'cyl'; hh: number; r: number }
  | { type: 'ball'; r: number }
  | { type: 'capsule'; hh: number; r: number }
  | { type: 'cone'; hh: number; r: number };

export interface PropDef {
  id: string;
  name: string;
  category: PropCategory;
  mass: number;
  shape: PropShape;
  material: 'matte' | 'plastic' | 'metal';
  build: () => THREE.BufferGeometry;
  grip: THREE.Vector3;
  reach: number;
  twoHanded: boolean;
  swing: { damage: number; knockback: number; daze: number };
  /** multiplier on impact damage when thrown */
  throwDamage: number;
  /** multiplier on daze when it hits */
  dazeMul: number;
  sound: PropSound;
  restitution: number;
  friction: number;
  linDamping: number;
  angDamping: number;
  gravityScale: number;
  spin?: number;
  special?: PropSpecial;
  /** impact speed (m/s) above which the special triggers */
  breakSpeed?: number;
  debrisColor: number;
}

const C = {
  orange: 0xff6a1a,
  white: 0xf4f1ea,
  black: 0x1d1d22,
  cardboard: 0xc49a62,
  tape: 0xe8d9a8,
  blue: 0x2f7fd8,
  basket: 0xe0672a,
  grey: 0x8f8f94,
  wood: 0xb5824e,
  woodDark: 0x7a5230,
  red: 0xd8322a,
  steel: 0xb8bcc4,
  green: 0x3f9d3a,
  greenDark: 0x226b25,
  pink: 0xff7ab8,
  yellow: 0xffd23f,
  bread: 0xd99a4e,
  breadDark: 0xa86a2c,
  skin: 0xf0c4a0,
};

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (r1: number, r2: number, h: number, s = 16) => new THREE.CylinderGeometry(r1, r2, h, s);
const sph = (r: number, w = 16, h = 12) => new THREE.SphereGeometry(r, w, h);

const base = {
  twoHanded: false,
  swing: { damage: 5, knockback: 3, daze: 8 },
  throwDamage: 1,
  dazeMul: 1,
  restitution: 0.25,
  friction: 0.7,
  linDamping: 0.05,
  angDamping: 0.15,
  gravityScale: 1,
  reach: 0.5,
  grip: new THREE.Vector3(0, -0.2, 0),
  material: 'matte' as const,
};

export const PROP_DEFS: Record<string, PropDef> = {
  cone: {
    ...base,
    id: 'cone',
    name: 'Plot de chantier',
    category: 'light',
    mass: 1.4,
    shape: { type: 'cone', hh: 0.33, r: 0.2 },
    material: 'plastic',
    build: () =>
      merge([
        // handle (tip) at -Y
        part(cyl(0.2, 0.025, 0.62, 18), C.orange, mat(0, -0.02, 0)),
        part(cyl(0.15, 0.1, 0.12, 18), C.white, mat(0, 0.0, 0)),
        part(roundedBox(0.42, 0.05, 0.42, 0.02), C.black, mat(0, 0.3, 0)),
      ]),
    grip: new THREE.Vector3(0, -0.28, 0),
    reach: 0.62,
    swing: { damage: 6, knockback: 3.5, daze: 10 },
    sound: 'plastic',
    restitution: 0.35,
    debrisColor: C.orange,
  },
  cardboard: {
    ...base,
    id: 'cardboard',
    name: 'Carton',
    category: 'light',
    mass: 1.6,
    shape: { type: 'box', hx: 0.24, hy: 0.19, hz: 0.19 },
    build: () =>
      merge([
        part(box(0.48, 0.38, 0.38), C.cardboard),
        part(box(0.1, 0.385, 0.385), C.tape),
        part(box(0.2, 0.06, 0.005), 0x8a2a1a, mat(0.1, 0.05, 0.193)),
      ]),
    grip: new THREE.Vector3(0, -0.1, 0),
    reach: 0.4,
    swing: { damage: 4, knockback: 3, daze: 6 },
    sound: 'cardboard',
    special: 'crumble',
    breakSpeed: 11,
    debrisColor: C.cardboard,
  },
  bucket: {
    ...base,
    id: 'bucket',
    name: 'Seau',
    category: 'light',
    mass: 1.1,
    shape: { type: 'cyl', hh: 0.18, r: 0.17 },
    material: 'plastic',
    build: () =>
      merge([
        part(cyl(0.17, 0.13, 0.36, 18), C.blue),
        part(cyl(0.175, 0.175, 0.03, 18), 0x1f5fb0, mat(0, 0.17, 0)),
        part(new THREE.TorusGeometry(0.16, 0.008, 5, 18, Math.PI), 0x999999, mat(0, 0.18, 0)),
      ]),
    grip: new THREE.Vector3(0, -0.15, 0),
    reach: 0.38,
    swing: { damage: 5, knockback: 3, daze: 12 },
    sound: 'plastic',
    debrisColor: C.blue,
  },
  ball: {
    ...base,
    id: 'ball',
    name: 'Ballon de basket',
    category: 'light',
    mass: 0.62,
    shape: { type: 'ball', r: 0.13 },
    material: 'plastic',
    build: () =>
      merge([
        part(sph(0.13, 20, 14), C.basket),
        part(new THREE.TorusGeometry(0.131, 0.005, 4, 28), C.black),
        part(new THREE.TorusGeometry(0.131, 0.005, 4, 28), C.black, mat(0, 0, 0, Math.PI / 2)),
        part(new THREE.TorusGeometry(0.131, 0.005, 4, 28), C.black, mat(0, 0, 0, 0, Math.PI / 2)),
      ]),
    grip: new THREE.Vector3(0, -0.1, 0),
    reach: 0.26,
    swing: { damage: 3, knockback: 2, daze: 6 },
    throwDamage: 1.6,
    dazeMul: 1.8,
    sound: 'rubber',
    restitution: 0.86,
    special: 'bouncy',
    debrisColor: C.basket,
  },
  chair: {
    ...base,
    id: 'chair',
    name: 'Chaise pliante',
    category: 'blunt',
    mass: 3.4,
    shape: { type: 'box', hx: 0.22, hy: 0.42, hz: 0.05 },
    material: 'metal',
    build: () => {
      const g: THREE.BufferGeometry[] = [];
      // folded chair: legs along Y, seat & backrest panels
      for (const x of [-0.19, 0.19]) g.push(part(cyl(0.015, 0.015, 0.84, 6), C.steel, mat(x, 0, 0)));
      g.push(part(roundedBox(0.42, 0.34, 0.03, 0.01), 0x2b2b30, mat(0, 0.22, 0.02)));
      g.push(part(roundedBox(0.4, 0.3, 0.03, 0.01), 0x2b2b30, mat(0, -0.15, -0.02)));
      g.push(part(cyl(0.012, 0.012, 0.4, 6), C.steel, mat(0, -0.4, 0, 0, 0, Math.PI / 2)));
      return merge(g);
    },
    grip: new THREE.Vector3(0, -0.36, 0),
    reach: 0.85,
    swing: { damage: 10, knockback: 7, daze: 22 },
    sound: 'metal',
    debrisColor: C.steel,
  },
  cinder: {
    ...base,
    id: 'cinder',
    name: 'Parpaing',
    category: 'heavy',
    mass: 11,
    shape: { type: 'box', hx: 0.2, hy: 0.1, hz: 0.1 },
    build: () =>
      merge([
        part(box(0.4, 0.2, 0.2), 0x9a9aa0),
        part(box(0.13, 0.205, 0.12), 0x5e5e64, mat(-0.1, 0, 0)),
        part(box(0.13, 0.205, 0.12), 0x5e5e64, mat(0.1, 0, 0)),
      ]),
    twoHanded: true,
    grip: new THREE.Vector3(0, 0, 0),
    reach: 0.3,
    throwDamage: 1.15,
    sound: 'stone',
    friction: 0.95,
    special: 'break',
    breakSpeed: 17,
    debrisColor: 0x9a9aa0,
  },
  crate: {
    ...base,
    id: 'crate',
    name: 'Caisse en bois',
    category: 'heavy',
    mass: 12,
    shape: { type: 'box', hx: 0.33, hy: 0.33, hz: 0.33 },
    build: () => {
      const g: THREE.BufferGeometry[] = [part(box(0.62, 0.62, 0.62), C.wood)];
      // frame boards
      for (const [x, y] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        g.push(part(box(0.1, 0.66, 0.1), C.woodDark, mat(x * 0.29, 0, y * 0.29)));
        g.push(part(box(0.66, 0.1, 0.1), C.woodDark, mat(0, x * 0.29, y * 0.29)));
        g.push(part(box(0.1, 0.1, 0.66), C.woodDark, mat(x * 0.29, y * 0.29, 0)));
      }
      g.push(part(box(0.64, 0.08, 0.64), C.woodDark, mat(0, 0, 0, 0, 0, Math.PI / 4).premultiply(new THREE.Matrix4().makeScale(1, 1, 0.02)).premultiply(mat(0, 0, 0.31))));
      g.push(part(box(0.64, 0.08, 0.64), C.woodDark, mat(0, 0, 0, 0, 0, -Math.PI / 4).premultiply(new THREE.Matrix4().makeScale(1, 1, 0.02)).premultiply(mat(0, 0, -0.31))));
      return merge(g);
    },
    twoHanded: true,
    grip: new THREE.Vector3(0, 0, 0),
    reach: 0.4,
    throwDamage: 1.1,
    sound: 'wood',
    special: 'break',
    breakSpeed: 8.5,
    debrisColor: C.wood,
  },
  gas: {
    ...base,
    id: 'gas',
    name: 'Bonbonne de gaz',
    category: 'heavy',
    mass: 14,
    shape: { type: 'capsule', hh: 0.25, r: 0.17 },
    material: 'metal',
    build: () =>
      merge([
        part(new THREE.CapsuleGeometry(0.17, 0.5, 6, 18), C.red),
        part(cyl(0.05, 0.06, 0.12, 10), C.steel, mat(0, 0.46, 0)),
        part(new THREE.TorusGeometry(0.08, 0.015, 6, 14), C.steel, mat(0, 0.52, 0, Math.PI / 2)),
        part(cyl(0.172, 0.172, 0.12, 18), C.white, mat(0, 0.05, 0)),
        part(box(0.06, 0.06, 0.005), C.black, mat(0, 0.05, 0.173)),
      ]),
    twoHanded: true,
    grip: new THREE.Vector3(0, 0, 0),
    reach: 0.45,
    throwDamage: 1,
    sound: 'gas',
    restitution: 0.2,
    special: 'explode',
    breakSpeed: 6,
    debrisColor: C.red,
  },
  tire: {
    ...base,
    id: 'tire',
    name: 'Pneu',
    category: 'heavy',
    mass: 8,
    shape: { type: 'cyl', hh: 0.11, r: 0.33 },
    build: () =>
      merge([
        part(new THREE.TorusGeometry(0.24, 0.1, 10, 22), 0x222226, mat(0, 0, 0, Math.PI / 2)),
        part(cyl(0.16, 0.16, 0.12, 16), 0x9a9aa0),
      ]),
    twoHanded: true,
    grip: new THREE.Vector3(0, 0, 0),
    reach: 0.4,
    throwDamage: 0.9,
    dazeMul: 1.3,
    sound: 'rubber',
    restitution: 0.65,
    special: 'bouncy',
    debrisColor: 0x222226,
  },
  melon: {
    ...base,
    id: 'melon',
    name: 'Pastèque',
    category: 'fun',
    mass: 5,
    shape: { type: 'ball', r: 0.2 },
    build: () => {
      const g = sph(0.2, 22, 16);
      g.scale(1.25, 1, 1);
      const parts = [part(g, C.green)];
      for (let i = 0; i < 8; i++) {
        const s = new THREE.TorusGeometry(0.2, 0.012, 4, 24, Math.PI);
        s.scale(1.25, 1, 1);
        parts.push(part(s, C.greenDark, mat(0, 0, 0, (i / 8) * Math.PI, Math.PI / 2, 0)));
      }
      return merge(parts);
    },
    twoHanded: true,
    grip: new THREE.Vector3(0, 0, 0),
    reach: 0.3,
    throwDamage: 0.8,
    dazeMul: 2.2,
    sound: 'melon',
    special: 'splat',
    breakSpeed: 6.5,
    debrisColor: 0xff3355,
  },
  bat: {
    ...base,
    id: 'bat',
    name: 'Batte de baseball',
    category: 'blunt',
    mass: 1.1,
    shape: { type: 'capsule', hh: 0.36, r: 0.045 },
    build: () =>
      merge([
        part(cyl(0.05, 0.022, 0.8, 12), 0xd9a066, mat(0, 0.03, 0)),
        part(cyl(0.032, 0.032, 0.03, 10), C.black, mat(0, -0.39, 0)),
        part(cyl(0.025, 0.025, 0.18, 10), 0x2a2a2a, mat(0, -0.28, 0)),
      ]),
    grip: new THREE.Vector3(0, -0.3, 0),
    reach: 0.78,
    swing: { damage: 13, knockback: 8, daze: 26 },
    throwDamage: 0.8,
    sound: 'wood',
    spin: 12,
    debrisColor: 0xd9a066,
  },
  pan: {
    ...base,
    id: 'pan',
    name: 'Poêle à frire',
    category: 'blunt',
    mass: 1.6,
    shape: { type: 'cyl', hh: 0.03, r: 0.17 },
    material: 'metal',
    build: () =>
      merge([
        // pan face toward +Z, handle toward -Y
        part(cyl(0.17, 0.14, 0.05, 22), 0x2a2a2e, mat(0, 0.12, 0, Math.PI / 2)),
        part(cyl(0.02, 0.02, 0.32, 8), 0x1a1a1e, mat(0, -0.17, 0)),
        part(cyl(0.135, 0.135, 0.005, 22), 0x55555c, mat(0, 0.12, 0.026, Math.PI / 2)),
      ]),
    grip: new THREE.Vector3(0, -0.26, 0),
    reach: 0.52,
    swing: { damage: 8, knockback: 6, daze: 45 },
    throwDamage: 1,
    dazeMul: 2,
    sound: 'pan',
    spin: 14,
    debrisColor: 0x2a2a2e,
  },
  plank: {
    ...base,
    id: 'plank',
    name: 'Planche à clous',
    category: 'blunt',
    mass: 2.4,
    shape: { type: 'box', hx: 0.06, hy: 0.55, hz: 0.02 },
    build: () => {
      const g = [part(box(0.12, 1.1, 0.04), C.wood)];
      for (let i = 0; i < 3; i++) g.push(part(cyl(0.004, 0.004, 0.08, 4), 0xcccccc, mat(-0.02 + i * 0.02, 0.45 - i * 0.03, 0.03, Math.PI / 2)));
      g.push(part(box(0.125, 0.15, 0.045), 0x4a3020, mat(0, -0.45, 0)));
      return merge(g);
    },
    grip: new THREE.Vector3(0, -0.45, 0),
    reach: 1.0,
    swing: { damage: 11, knockback: 7.5, daze: 18 },
    sound: 'wood',
    spin: 9,
    special: 'break',
    breakSpeed: 22,
    debrisColor: C.wood,
  },
  stop: {
    ...base,
    id: 'stop',
    name: 'Panneau STOP',
    category: 'blunt',
    mass: 3.2,
    shape: { type: 'box', hx: 0.3, hy: 0.75, hz: 0.04 },
    material: 'metal',
    build: () => {
      const oct = new THREE.CylinderGeometry(0.3, 0.3, 0.02, 8);
      oct.rotateX(Math.PI / 2);
      oct.rotateZ(Math.PI / 8);
      const inner = new THREE.CylinderGeometry(0.26, 0.26, 0.022, 8);
      inner.rotateX(Math.PI / 2);
      inner.rotateZ(Math.PI / 8);
      return merge([
        part(cyl(0.025, 0.025, 1.2, 8), C.steel, mat(0, -0.2, 0)),
        part(oct, C.white, mat(0, 0.45, 0.02)),
        part(inner, C.red, mat(0, 0.45, 0.022)),
        part(box(0.3, 0.06, 0.024), C.white, mat(0, 0.45, 0.024)),
      ]);
    },
    grip: new THREE.Vector3(0, -0.6, 0),
    reach: 1.25,
    swing: { damage: 11, knockback: 9.5, daze: 20 },
    sound: 'metal',
    spin: 8,
    debrisColor: C.red,
  },
  chicken: {
    ...base,
    id: 'chicken',
    name: 'Poulet en caoutchouc',
    category: 'fun',
    mass: 0.4,
    shape: { type: 'capsule', hh: 0.18, r: 0.06 },
    material: 'plastic',
    build: () =>
      merge([
        part(new THREE.CapsuleGeometry(0.06, 0.3, 6, 12), C.yellow, mat(0, 0.02, 0)),
        part(sph(0.07, 12, 10), C.yellow, mat(0, 0.23, 0.01)),
        part(new THREE.ConeGeometry(0.03, 0.08, 8), C.orange, mat(0, 0.24, 0.08, Math.PI / 2)),
        part(box(0.02, 0.06, 0.04), C.red, mat(0, 0.31, 0)),
        part(sph(0.012, 6, 4), C.black, mat(0.04, 0.26, 0.05)),
        part(sph(0.012, 6, 4), C.black, mat(-0.04, 0.26, 0.05)),
        part(cyl(0.01, 0.01, 0.12, 5), C.orange, mat(0.03, -0.2, 0)),
        part(cyl(0.01, 0.01, 0.12, 5), C.orange, mat(-0.03, -0.2, 0)),
      ]),
    grip: new THREE.Vector3(0, -0.2, 0),
    reach: 0.55,
    swing: { damage: 2, knockback: 2.5, daze: 9 },
    throwDamage: 0.5,
    dazeMul: 1.5,
    sound: 'squeak',
    special: 'squeak',
    spin: 16,
    debrisColor: C.yellow,
  },
  baguette: {
    ...base,
    id: 'baguette',
    name: 'Baguette',
    category: 'fun',
    mass: 0.25,
    shape: { type: 'capsule', hh: 0.3, r: 0.04 },
    build: () => {
      const g = [part(new THREE.CapsuleGeometry(0.04, 0.62, 6, 12), C.bread)];
      for (let i = 0; i < 4; i++) g.push(part(box(0.06, 0.02, 0.012), C.breadDark, mat(0, -0.2 + i * 0.13, 0.038, 0, 0, 0.6)));
      return merge(g);
    },
    grip: new THREE.Vector3(0, -0.28, 0),
    reach: 0.66,
    swing: { damage: 3, knockback: 2.5, daze: 7 },
    throwDamage: 0.5,
    sound: 'bread',
    special: 'crumble',
    spin: 12,
    debrisColor: C.bread,
  },
  gnome: {
    ...base,
    id: 'gnome',
    name: 'Nain de jardin',
    category: 'fun',
    mass: 3.8,
    shape: { type: 'capsule', hh: 0.13, r: 0.13 },
    build: () =>
      merge([
        part(cyl(0.12, 0.14, 0.22, 14), C.blue, mat(0, -0.12, 0)),
        part(sph(0.1, 14, 10), C.skin, mat(0, 0.06, 0)),
        part(new THREE.ConeGeometry(0.11, 0.26, 14), C.red, mat(0, 0.25, 0, -0.15)),
        part(sph(0.08, 12, 8), C.white, mat(0, 0.0, 0.06, 0, 0, 0, 1, 1.2, 0.8)),
        part(sph(0.025, 8, 6), 0xff9a8a, mat(0, 0.06, 0.1)),
        part(cyl(0.15, 0.15, 0.04, 14), C.green, mat(0, -0.24, 0)),
      ]),
    grip: new THREE.Vector3(0, -0.2, 0),
    reach: 0.45,
    swing: { damage: 9, knockback: 5, daze: 24 },
    throwDamage: 1.1,
    sound: 'ceramic',
    special: 'break',
    breakSpeed: 9,
    debrisColor: C.red,
  },
  flamingo: {
    ...base,
    id: 'flamingo',
    name: 'Flamant gonflable',
    category: 'fun',
    mass: 0.5,
    shape: { type: 'capsule', hh: 0.35, r: 0.22 },
    material: 'plastic',
    build: () =>
      merge([
        part(new THREE.CapsuleGeometry(0.22, 0.4, 8, 16), C.pink, mat(0, -0.2, 0)),
        part(new THREE.CapsuleGeometry(0.06, 0.45, 6, 10), C.pink, mat(0, 0.3, 0.1, 0.3)),
        part(sph(0.09, 12, 10), C.pink, mat(0, 0.6, 0.16)),
        part(new THREE.ConeGeometry(0.04, 0.12, 8), C.black, mat(0, 0.58, 0.28, Math.PI / 2 + 0.4)),
        part(sph(0.018, 6, 4), C.black, mat(0.06, 0.63, 0.2)),
        part(sph(0.018, 6, 4), C.black, mat(-0.06, 0.63, 0.2)),
      ]),
    grip: new THREE.Vector3(0, -0.45, 0),
    reach: 0.9,
    swing: { damage: 0.5, knockback: 9, daze: 3 },
    throwDamage: 0.1,
    dazeMul: 0.2,
    sound: 'rubber',
    linDamping: 1.4,
    angDamping: 1.2,
    gravityScale: 0.35,
    restitution: 0.7,
    special: 'float',
    debrisColor: C.pink,
  },
};

/** Where props spawn on the roof: [defId, x, z, rotY]. Long props spawn lying down. */
export const PROP_LAYOUT: [string, number, number, number][] = [
  ['cone', -2.2, -8.8, 0.3],
  ['cone', -0.8, -8.9, 1.1],
  ['cone', 0.6, -8.7, 2.0],
  ['cone', 3.2, 9.0, 0.4],
  ['cardboard', 4.6, -4.7, 0.2],
  ['cardboard', 4.9, -4.6, 1.3],
  ['cardboard', -6.2, 2.3, 0.8],
  ['bucket', -4.8, -2.8, 0],
  ['bucket', 7.2, 1.0, 0],
  ['ball', -1.5, 2.5, 0],
  ['ball', 9.4, -3.9, 0],
  ['chair', -8.6, 4.6, 1.2],
  ['chair', 2.1, -5.2, 0.4],
  ['cinder', -6.6, -3.2, 0.3],
  ['cinder', -6.0, -3.6, 1.0],
  ['cinder', 11.6, 1.6, 0.5],
  ['crate', 8.2, -4.9, 0.1],
  ['crate', 9.0, -4.6, 0.6],
  ['crate', -3.4, -6.3, 0.2],
  ['gas', -11.7, -2.6, 0],
  ['gas', 12.2, 9.2, 0],
  ['tire', 6.0, 6.6, 0],
  ['tire', -3.6, 8.6, 0],
  ['melon', -8.9, 7.9, 0],
  ['melon', -10.9, 8.4, 0],
  ['bat', -4.3, 4.6, 0.6],
  ['pan', -9.4, 5.5, 0.2],
  ['pan', 6.1, -1.8, 0],
  ['plank', 3.6, -8.6, 1.4],
  ['plank', -12.1, -8.6, 0.3],
  ['stop', 1.4, -9.1, 0],
  ['chicken', 1.2, 4.8, 0.5],
  ['chicken', -11.6, 5.2, 0.3],
  ['baguette', -8.2, 8.9, 1.0],
  ['baguette', 8.3, 3.2, 0.2],
  ['gnome', -5.9, 5.6, 0.4],
  ['gnome', 12.1, 5.5, 0],
  ['flamingo', -7.4, 6.6, 0.5],
];
