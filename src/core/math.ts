import * as THREE from 'three';

/** Shared math helpers. Everything here is allocation-free on the hot path. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => clamp01((v - a) / (b - a));
export const remap = (v: number, a: number, b: number, c: number, d: number) => lerp(c, d, invLerp(a, b, v));
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t: number) => t * t * t;
export const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Frame-rate independent exponential smoothing factor. */
export const dampFactor = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt);
export const damp = (a: number, b: number, lambda: number, dt: number) => lerp(a, b, dampFactor(lambda, dt));

export const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};
export const dampAngle = (a: number, b: number, lambda: number, dt: number) =>
  a + wrapAngle(b - a) * dampFactor(lambda, dt);

export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
export const chance = (p: number) => Math.random() < p;

/** Cheap smooth 1D value noise (deterministic per seed), range ~[-1, 1]. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    const s = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u);
}

/**
 * Critically-damped / under-damped scalar spring. Used for camera kicks,
 * view-model sway and hit reactions — gives organic overshoot "for free".
 */
export class Spring {
  value = 0;
  velocity = 0;
  constructor(public stiffness = 120, public damping = 12, public target = 0) {}
  update(dt: number) {
    const f = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
    this.velocity += f * dt;
    this.value += this.velocity * dt;
    return this.value;
  }
  impulse(v: number) {
    this.velocity += v;
  }
  reset(v = 0) {
    this.value = v;
    this.velocity = 0;
  }
}

/** 3D vector spring (component-wise). */
export class Spring3 {
  value = new THREE.Vector3();
  velocity = new THREE.Vector3();
  target = new THREE.Vector3();
  constructor(public stiffness = 120, public damping = 12) {}
  update(dt: number) {
    const k = this.stiffness;
    const c = this.damping;
    const v = this.value;
    const w = this.velocity;
    const t = this.target;
    w.x += (-k * (v.x - t.x) - c * w.x) * dt;
    w.y += (-k * (v.y - t.y) - c * w.y) * dt;
    w.z += (-k * (v.z - t.z) - c * w.z) * dt;
    v.x += w.x * dt;
    v.y += w.y * dt;
    v.z += w.z * dt;
    return v;
  }
  impulse(x: number, y: number, z: number) {
    this.velocity.x += x;
    this.velocity.y += y;
    this.velocity.z += z;
  }
  reset() {
    this.value.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
  }
}

/**
 * Closest distance squared between segments [p1,q1] and [p2,q2].
 * Writes the closest points into c1/c2 if provided. (Ericson, RTCD 5.1.9)
 */
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _r = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
export function segmentSegmentDistSq(
  p1: THREE.Vector3,
  q1: THREE.Vector3,
  p2: THREE.Vector3,
  q2: THREE.Vector3,
  c1: THREE.Vector3 = _c1,
  c2: THREE.Vector3 = _c2,
): number {
  _d1.subVectors(q1, p1);
  _d2.subVectors(q2, p2);
  _r.subVectors(p1, p2);
  const a = _d1.dot(_d1);
  const e = _d2.dot(_d2);
  const f = _d2.dot(_r);
  let s = 0;
  let t = 0;
  const EPS = 1e-8;
  if (a <= EPS && e <= EPS) {
    c1.copy(p1);
    c2.copy(p2);
    return c1.distanceToSquared(c2);
  }
  if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = _d1.dot(_r);
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = _d1.dot(_d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  c1.copy(p1).addScaledVector(_d1, s);
  c2.copy(p2).addScaledVector(_d2, t);
  return c1.distanceToSquared(c2);
}

/** Catmull-Rom interpolation through keyframed points (uniform). */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Horizontal forward vector for a yaw angle (three.js camera convention: yaw 0 looks down -Z). */
export function forwardFromYaw(yaw: number, out: THREE.Vector3) {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}
export function rightFromYaw(yaw: number, out: THREE.Vector3) {
  return out.set(Math.cos(yaw), 0, -Math.sin(yaw));
}
export function yawFromDir(x: number, z: number) {
  return Math.atan2(-x, -z);
}

/** Scratch objects for short-lived calculations. Never hold references to these across calls. */
export const tmpV1 = new THREE.Vector3();
export const tmpV2 = new THREE.Vector3();
export const tmpV3 = new THREE.Vector3();
export const tmpQ1 = new THREE.Quaternion();
export const tmpQ2 = new THREE.Quaternion();
export const tmpM1 = new THREE.Matrix4();
export const UP = new THREE.Vector3(0, 1, 0);
