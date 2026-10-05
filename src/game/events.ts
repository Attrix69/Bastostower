import type * as THREE from 'three';
import type { Fighter } from '../fighters/Fighter';
import type { Prop } from '../props/PropSystem';
import type { FState } from '../fighters/states';

export type HitKind = 'punch' | 'kick' | 'swing' | 'prop' | 'body' | 'explosion' | 'shove' | 'fall';
export type Zone = 'head' | 'torso' | 'legs';

export interface HitEvent {
  attacker: Fighter | null;
  victim: Fighter;
  point: THREE.Vector3;
  dir: THREE.Vector3;
  kind: HitKind;
  zone: Zone;
  damage: number;
  /** 0..~2 normalized impact strength for feedback scaling */
  power: number;
  heavy: boolean;
  blocked: boolean;
  perfect: boolean;
  prop?: Prop;
  /** what the victim became */
  result: 'hit' | 'stun' | 'ko' | 'launch' | 'blocked' | 'guardbreak';
  attackName?: string;
}

export type FallCause = 'thrown' | 'pushed' | 'prop' | 'self' | 'explosion';

export interface GameEvents {
  hit: HitEvent;
  whoosh: { fighter: Fighter; pos: THREE.Vector3; heavy: boolean; kind: string };
  stateChange: { fighter: Fighter; from: FState; to: FState };
  parry: { attacker: Fighter; victim: Fighter; point: THREE.Vector3 };
  grab: { attacker: Fighter; victim: Fighter };
  lift: { attacker: Fighter; victim: Fighter };
  throwBody: { attacker: Fighter; victim: Fighter; speed: number };
  dropBody: { attacker: Fighter; victim: Fighter };
  escape: { victim: Fighter; attacker: Fighter };
  pickup: { fighter: Fighter; prop: Prop };
  throwProp: { fighter: Fighter; prop: Prop; speed: number };
  dropProp: { fighter: Fighter; prop: Prop };
  propImpact: { prop: Prop; pos: THREE.Vector3; speed: number };
  propBreak: { prop: Prop; pos: THREE.Vector3 };
  explosion: { pos: THREE.Vector3; radius: number; by: Fighter | null };
  footstep: { fighter: Fighter; pos: THREE.Vector3; intensity: number };
  land: { fighter: Fighter; pos: THREE.Vector3; speed: number };
  jump: { fighter: Fighter };
  dodge: { fighter: Fighter };
  bodyImpact: { fighter: Fighter; pos: THREE.Vector3; speed: number; part: number };
  railingBreak: { pos: THREE.Vector3 };
  teeter: { fighter: Fighter };
  fall: { fighter: Fighter; cause: FallCause; by: Fighter | null; prop?: string };
  taunt: { fighter: Fighter; text: string };
  exhausted: { fighter: Fighter };
  charge: { fighter: Fighter; ready: boolean };
}
