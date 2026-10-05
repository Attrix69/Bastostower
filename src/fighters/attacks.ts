import * as THREE from 'three';
import { catmullRom } from '../core/math';

/**
 * Attack definitions.
 *
 * Every strike is a keyframed trajectory of the striking limb, expressed in the
 * attacker's AIM SPACE (three.js camera convention: +x right, +y up, -z forward;
 * origin = eyes for punches, feet for kicks). The SAME trajectory drives:
 *   - the hitbox (swept sphere tested against the victim's hurtboxes),
 *   - the enemy rig arm/leg (IK), and
 *   - the player's first-person fists/leg.
 * So what you see is exactly what hits.
 *
 * Input model: press → limb pulls back (anticipation), release → strike.
 * Release before HEAVY_THRESHOLD = quick attack; hold longer = charged heavy.
 */

export type Limb = 'handL' | 'handR' | 'footR' | 'weapon';
export type AttackKind = 'punch' | 'kick' | 'swing' | 'shove';

export interface Key {
  t: number;
  p: [number, number, number];
}

export interface AttackDef {
  id: string;
  name: string;
  kind: AttackKind;
  limb: Limb;
  /** trajectory frame: 'aim' (eyes, yaw+pitch) or 'body' (feet, yaw only) */
  frame: 'aim' | 'body';
  /** pose held while the button is down */
  pull: [number, number, number];
  path: Key[];
  /** hitbox live window, seconds after release */
  active: [number, number];
  duration: number;
  /** can chain into the next attack after this time */
  cancelAt: number;
  radius: number;
  damage: number;
  knockback: number;
  lift: number;
  daze: number;
  stamina: number;
  hitstop: number;
  /** extra yaw "slap" direction for hooks (-1 left, 1 right) */
  lateral: number;
  /** attacker camera kick (pitch, yaw, roll) in radians */
  camKick: [number, number, number];
  /** how much the fighter lunges forward during the strike (m) */
  lunge: number;
}

export const HEAVY_THRESHOLD = 0.17;
export const MAX_CHARGE_TIME = 0.85;
export const AUTO_RELEASE = 1.6;

export const GUARD_L: [number, number, number] = [-0.2, -0.2, -0.36];
export const GUARD_R: [number, number, number] = [0.21, -0.23, -0.33];
export const FOOT_REST: [number, number, number] = [0.13, 0.07, 0.04];

const def = (d: Partial<AttackDef> & Pick<AttackDef, 'id' | 'name' | 'kind' | 'limb' | 'pull' | 'path' | 'active'>): AttackDef => ({
  frame: 'aim',
  duration: d.path[d.path.length - 1].t,
  cancelAt: d.path[d.path.length - 1].t * 0.7,
  radius: 0.15,
  damage: 6,
  knockback: 2.5,
  lift: 0.4,
  daze: 8,
  stamina: 6,
  hitstop: 0.05,
  lateral: 0,
  camKick: [0.02, 0, 0],
  lunge: 0.06,
  ...d,
});

export const ATTACKS = {
  jabL: def({
    id: 'jabL',
    name: 'Jab',
    kind: 'punch',
    limb: 'handL',
    pull: [-0.23, -0.19, -0.25],
    path: [
      { t: 0, p: [-0.23, -0.19, -0.25] },
      { t: 0.045, p: [-0.13, -0.11, -0.62] },
      { t: 0.085, p: [-0.07, -0.07, -0.86] },
      { t: 0.13, p: [-0.09, -0.1, -0.74] },
      { t: 0.27, p: GUARD_L },
    ],
    active: [0.025, 0.12],
    cancelAt: 0.16,
    damage: 6,
    knockback: 2.4,
    lift: 0.3,
    daze: 9,
    stamina: 5,
    hitstop: 0.045,
    camKick: [0.015, -0.01, -0.01],
  }),
  crossR: def({
    id: 'crossR',
    name: 'Direct',
    kind: 'punch',
    limb: 'handR',
    pull: [0.25, -0.21, -0.22],
    path: [
      { t: 0, p: [0.25, -0.21, -0.22] },
      { t: 0.05, p: [0.15, -0.12, -0.6] },
      { t: 0.095, p: [0.06, -0.07, -0.88] },
      { t: 0.14, p: [0.08, -0.1, -0.76] },
      { t: 0.3, p: GUARD_R },
    ],
    active: [0.03, 0.13],
    cancelAt: 0.18,
    damage: 8,
    knockback: 3.2,
    lift: 0.4,
    daze: 11,
    stamina: 7,
    hitstop: 0.055,
    camKick: [0.02, 0.012, 0.012],
  }),
  hookL: def({
    id: 'hookL',
    name: 'Crochet',
    kind: 'punch',
    limb: 'handL',
    pull: [-0.38, -0.12, -0.12],
    path: [
      { t: 0, p: [-0.38, -0.12, -0.12] },
      { t: 0.06, p: [-0.36, -0.05, -0.5] },
      { t: 0.11, p: [-0.12, -0.03, -0.84] },
      { t: 0.16, p: [0.12, -0.07, -0.74] },
      { t: 0.24, p: [0.2, -0.14, -0.55] },
      { t: 0.5, p: GUARD_L },
    ],
    active: [0.05, 0.2],
    cancelAt: 0.34,
    radius: 0.18,
    damage: 15,
    knockback: 6,
    lift: 1.2,
    daze: 26,
    stamina: 15,
    hitstop: 0.09,
    lateral: 1,
    camKick: [0.03, 0.06, 0.05],
    lunge: 0.14,
  }),
  uppercutR: def({
    id: 'uppercutR',
    name: 'Uppercut',
    kind: 'punch',
    limb: 'handR',
    pull: [0.3, -0.44, -0.16],
    path: [
      { t: 0, p: [0.3, -0.44, -0.16] },
      { t: 0.07, p: [0.2, -0.38, -0.52] },
      { t: 0.12, p: [0.06, -0.12, -0.8] },
      { t: 0.17, p: [0.02, 0.12, -0.72] },
      { t: 0.25, p: [0.05, 0.18, -0.55] },
      { t: 0.52, p: GUARD_R },
    ],
    active: [0.06, 0.21],
    cancelAt: 0.36,
    radius: 0.18,
    damage: 17,
    knockback: 4.5,
    lift: 4.2,
    daze: 30,
    stamina: 16,
    hitstop: 0.1,
    camKick: [0.06, 0.0, -0.02],
    lunge: 0.12,
  }),
  kick: def({
    id: 'kick',
    name: 'Coup de pied',
    kind: 'kick',
    limb: 'footR',
    frame: 'body',
    pull: [0.12, 0.6, -0.12],
    path: [
      { t: 0, p: [0.12, 0.6, -0.12] },
      { t: 0.07, p: [0.08, 0.82, -0.6] },
      { t: 0.12, p: [0.05, 0.86, -0.93] },
      { t: 0.2, p: [0.08, 0.72, -0.62] },
      { t: 0.38, p: FOOT_REST },
    ],
    active: [0.05, 0.17],
    cancelAt: 0.3,
    radius: 0.2,
    damage: 8,
    knockback: 7,
    lift: 1.0,
    daze: 7,
    stamina: 13,
    hitstop: 0.07,
    camKick: [-0.03, 0, 0],
    lunge: 0.1,
  }),
  spartaKick: def({
    id: 'spartaKick',
    name: 'Coup de pied spartiate',
    kind: 'kick',
    limb: 'footR',
    frame: 'body',
    pull: [0.12, 0.78, 0.06],
    path: [
      { t: 0, p: [0.12, 0.78, 0.06] },
      { t: 0.08, p: [0.08, 0.92, -0.55] },
      { t: 0.14, p: [0.04, 0.96, -1.02] },
      { t: 0.25, p: [0.06, 0.86, -0.86] },
      { t: 0.48, p: FOOT_REST },
    ],
    active: [0.06, 0.22],
    cancelAt: 0.4,
    radius: 0.24,
    damage: 12,
    knockback: 9.8,
    lift: 2.6,
    daze: 14,
    stamina: 24,
    hitstop: 0.11,
    camKick: [-0.05, 0, 0],
    lunge: 0.22,
  }),
  swing: def({
    id: 'swing',
    name: 'Coup d\'objet',
    kind: 'swing',
    limb: 'weapon',
    pull: [0.4, 0.04, -0.12],
    path: [
      { t: 0, p: [0.4, 0.04, -0.12] },
      { t: 0.07, p: [0.34, -0.02, -0.5] },
      { t: 0.13, p: [0.05, -0.1, -0.68] },
      { t: 0.2, p: [-0.25, -0.2, -0.55] },
      { t: 0.28, p: [-0.3, -0.28, -0.4] },
      { t: 0.55, p: [0.26, -0.26, -0.42] },
    ],
    active: [0.04, 0.24],
    cancelAt: 0.4,
    radius: 0.14,
    damage: 1,
    knockback: 1,
    lift: 1,
    daze: 1,
    stamina: 12,
    hitstop: 0.08,
    lateral: -1,
    camKick: [0.02, -0.05, -0.04],
    lunge: 0.1,
  }),
  shove: def({
    id: 'shove',
    name: 'Poussée',
    kind: 'shove',
    limb: 'handR',
    pull: [0.15, -0.3, -0.35],
    path: [
      { t: 0, p: [0.15, -0.3, -0.35] },
      { t: 0.1, p: [0.1, -0.25, -0.85] },
      { t: 0.35, p: [0.15, -0.3, -0.45] },
    ],
    active: [0.05, 0.15],
    cancelAt: 0.3,
    damage: 3,
    knockback: 9,
    lift: 1.5,
    daze: 5,
    stamina: 10,
  }),
} satisfies Record<string, AttackDef>;

export type AttackId = keyof typeof ATTACKS;

/** Quick/heavy pairs per input button. */
export const BUTTON_ATTACKS = {
  punchL: { quick: ATTACKS.jabL, heavy: ATTACKS.hookL },
  punchR: { quick: ATTACKS.crossR, heavy: ATTACKS.uppercutR },
  kick: { quick: ATTACKS.kick, heavy: ATTACKS.spartaKick },
} as const;

/** Sample a trajectory (Catmull-Rom through keys). */
export function samplePath(path: Key[], t: number, out: THREE.Vector3) {
  if (t <= path[0].t) return out.set(...path[0].p);
  const last = path[path.length - 1];
  if (t >= last.t) return out.set(...last.p);
  let i = 0;
  while (i < path.length - 2 && t > path[i + 1].t) i++;
  const k1 = path[i];
  const k2 = path[i + 1];
  const k0 = path[Math.max(0, i - 1)];
  const k3 = path[Math.min(path.length - 1, i + 2)];
  const u = (t - k1.t) / (k2.t - k1.t);
  return out.set(
    catmullRom(k0.p[0], k1.p[0], k2.p[0], k3.p[0], u),
    catmullRom(k0.p[1], k1.p[1], k2.p[1], k3.p[1], u),
    catmullRom(k0.p[2], k1.p[2], k2.p[2], k3.p[2], u),
  );
}

/** Running instance of an attack. */
export class ActionInstance {
  /** 'hold' while the button is held, then 'strike' after release */
  phase: 'hold' | 'strike' = 'hold';
  holdTime = 0;
  t = 0;
  charge = 0;
  def: AttackDef;
  readonly hit = new Set<unknown>();
  readonly prevPoint = new THREE.Vector3();
  readonly point = new THREE.Vector3();
  hasPrev = false;
  /** whether this attack connected at least once */
  connected = false;

  constructor(
    readonly button: 'punchL' | 'punchR' | 'kick' | 'swing' | 'throw' | 'shove',
    readonly quick: AttackDef,
    readonly heavy: AttackDef | null,
  ) {
    this.def = quick;
  }

  get heavyReady() {
    return this.heavy !== null && this.holdTime >= HEAVY_THRESHOLD;
  }

  release() {
    if (this.phase !== 'hold') return;
    this.phase = 'strike';
    this.t = 0;
    if (this.heavy && this.holdTime >= HEAVY_THRESHOLD) {
      this.def = this.heavy;
      this.charge = Math.min(1, (this.holdTime - HEAVY_THRESHOLD) / MAX_CHARGE_TIME);
    } else {
      this.def = this.quick;
      this.charge = 0;
    }
  }

  get isActive() {
    return this.phase === 'strike' && this.t >= this.def.active[0] && this.t <= this.def.active[1];
  }

  get done() {
    return this.phase === 'strike' && this.t >= this.def.duration;
  }

  /** power multiplier from charge (heavy only) */
  get power() {
    return this.def === this.heavy ? 1 + this.charge * 0.85 : 1;
  }
}
