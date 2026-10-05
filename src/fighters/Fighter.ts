import * as THREE from 'three';
import { G, groups, RAPIER } from '../physics/Physics';
import type { GameContext } from '../game/Context';
import type { FallCause, HitKind, Zone, HitEvent } from '../game/events';
import type { Prop } from '../props/PropSystem';
import { FALL_Y, ROOF } from '../world/Arena';
import { clamp, clamp01, forwardFromYaw, noise1, rightFromYaw, tmpV1, wrapAngle } from '../core/math';
import { ActionInstance, AttackDef, ATTACKS, AUTO_RELEASE, BUTTON_ATTACKS, samplePath } from './attacks';
import { Animator } from './Animator';
import type { CharacterDef } from './Characters';
import { Intent, Btn } from './Intent';
import { Ragdoll, RP } from './Ragdoll';
import { B, Rig } from './Rig';
import { FState, RULES, TRANSITIONS } from './states';

export const CAPSULE_R = 0.34;
export const CAPSULE_HH = 0.5;
export const CAPSULE_CY = CAPSULE_R + CAPSULE_HH;
const WALK = 4.5;
const SPRINT_MUL = 1.5;
const JUMP_V = 5.8;
const GRAVITY = 19;
/** horizontal knockback speed above which the victim goes full ragdoll */
const RAGDOLL_KB = 8.6;
/** max horizontal launch speed of a knocked-out flight (keeps knockouts readable) */
const MAX_LAUNCH = 13;
/** pushed into a low wall faster than this → trip over it */
const TRIP_KB = 5.2;

export type Hold =
  | { kind: 'prop'; prop: Prop; twoHanded: boolean }
  | { kind: 'fighter'; target: Fighter; mode: 'drag' | 'carry'; t: number; lift: number };

export interface Hurtbox {
  zone: Zone;
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
  part: number;
}

export interface IncomingHit {
  attacker: Fighter | null;
  kind: HitKind;
  damage: number;
  knockback: number;
  lift: number;
  daze: number;
  dir: THREE.Vector3;
  point: THREE.Vector3;
  zone: Zone;
  heavy: boolean;
  part?: number;
  prop?: Prop;
  unblockable?: boolean;
  attackName?: string;
}

/** Throwing (objects or bodies) is an "attack" too: hold to charge, release to throw. */
const THROW_DEF: AttackDef = {
  ...ATTACKS.crossR,
  id: 'throw',
  name: 'Lancer',
  kind: 'shove',
  limb: 'handR',
  pull: [0.27, 0.08, -0.3],
  path: [
    { t: 0, p: [0.27, 0.08, -0.3] },
    { t: 0.08, p: [0.18, 0.0, -0.55] },
    { t: 0.16, p: [0.1, -0.15, -0.7] },
    { t: 0.4, p: [0.24, -0.26, -0.42] },
  ],
  active: [0.06, 0.07],
  duration: 0.4,
  cancelAt: 0.3,
  stamina: 6,
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _rv = new THREE.Vector3();
const _tv = new THREE.Vector3();
const _tq = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
// carry orientation: victim's spine along carrier right, belly up
const CARRY_BASIS = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0)),
);

export class Fighter {
  readonly rig: Rig;
  readonly ragdoll: Ragdoll;
  readonly animator: Animator;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private kcc: RAPIER.KinematicCharacterController;
  readonly layer: number;
  readonly intent = new Intent();
  opponent!: Fighter;

  readonly pos = new THREE.Vector3();
  readonly prevPos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly kb = new THREE.Vector3();
  yaw = 0;
  prevYaw = 0;
  pitch = 0;
  grounded = true;
  airTime = 0;

  state = FState.Normal;
  stateTime = 0;
  maxHealth = 100;
  health = 100;
  stamina = 100;
  daze = 0;
  koMeter = 0;
  koTimer = 0;
  stunTimer = 0;
  hitTimer = 0;
  invuln = 0;
  getUpDuration = 0.9;
  private settle = 0;
  private lastStaminaUse = -10;
  lastHitTime = -10;
  blocking = false;
  blockStart = -10;
  dodgeTimer = 0;
  dodgeCooldown = 0;
  readonly dodgeDir = new THREE.Vector3();
  action: ActionInstance | null = null;
  private buffer: { button: 'punchL' | 'punchR' | 'kick'; time: number } | null = null;
  hold: Hold | null = null;
  heldBy: Fighter | null = null;
  escape = 0;
  private ignoreCarrierTimer = 0;
  teeter = 0;
  /** distance accumulator for footsteps */
  private stepDist = 0;
  combo = 0;
  lastLanded = -10;
  lastAttacker: { by: Fighter | null; cause: FallCause; time: number; prop?: string } | null = null;
  /** big airborne/launch timer for camera & fx */
  launchTime = -10;
  readonly hurtboxes: Hurtbox[] = [];
  readonly stats = { hits: 0, damage: 0, maxCombo: 0, propsThrown: 0, kos: 0, throws: 0, blocks: 0 };
  /** exhausted (stamina hit 0): must regen to 25 before acting */
  exhausted = false;
  private lastDt = 1 / 60;

  constructor(
    readonly ctx: GameContext,
    readonly index: 0 | 1,
    readonly def: CharacterDef,
    readonly isPlayer: boolean,
  ) {
    this.rig = new Rig(def.look);
    this.animator = new Animator(this);
    this.layer = index === 0 ? G.F0 : G.F1;
    const otherF = index === 0 ? G.F1 : G.F0;
    const otherR = index === 0 ? G.R1 : G.R0;
    const world = ctx.physics.world;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, CAPSULE_CY, 0));
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(CAPSULE_HH, CAPSULE_R)
        .setCollisionGroups(groups(this.layer, G.STATIC | G.PROP | otherF | otherR | G.DEBRIS))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setFriction(0.2),
      this.body,
    );
    ctx.physics.register(this.collider, { kind: 'fighter', ref: this, material: 'flesh' });
    this.kcc = world.createCharacterController(0.02);
    this.kcc.enableAutostep(0.32, 0.15, false);
    this.kcc.enableSnapToGround(0.3);
    this.kcc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((35 * Math.PI) / 180);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(80 * def.stats.mass);
    this.kcc.setSlideEnabled(true);
    this.ragdoll = new Ragdoll(ctx.physics, this.rig, index, def.stats.mass, this);
    const zones: [Zone, number][] = [
      ['head', RP.head],
      ['torso', RP.chest],
      ['legs', RP.thighL],
      ['legs', RP.shinL],
      ['legs', RP.thighR],
      ['legs', RP.shinR],
      ['torso', RP.upperArmL],
      ['torso', RP.upperArmR],
    ];
    for (const [zone, part] of zones) this.hurtboxes.push({ zone, a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.1, part });
  }

  get name() {
    return this.def.name;
  }
  get rule() {
    return RULES[this.state];
  }
  get massMul() {
    return this.def.stats.mass;
  }
  get eyeHeight() {
    return this.rig.dims.eyeHeight;
  }
  get isDown() {
    return this.rule.ragdoll;
  }
  get speedXZ() {
    return Math.hypot(this.vel.x + this.kb.x, this.vel.z + this.kb.z);
  }

  // ------------------------------------------------------------------ lifecycle
  /** Enemies are pooled: inactive ones are removed from the simulation and hidden. */
  setActive(on: boolean) {
    if (!on) {
      if (this.hold) this.releaseHold('drop');
      this.ragdoll.deactivate();
    }
    this.body.setEnabled(on);
    this.collider.setEnabled(on);
    this.rig.mesh.visible = on;
  }

  spawn(p: THREE.Vector3, yaw: number) {
    if (this.hold) this.releaseHold('drop');
    this.heldBy = null;
    this.ragdoll.deactivate();
    this.collider.setEnabled(true);
    this.pos.copy(p);
    this.prevPos.copy(p);
    this.body.setTranslation({ x: p.x, y: p.y + CAPSULE_CY, z: p.z }, true);
    this.vel.set(0, 0, 0);
    this.kb.set(0, 0, 0);
    this.yaw = this.prevYaw = yaw;
    this.pitch = 0;
    this.intent.reset();
    this.intent.yaw = yaw;
    this.state = FState.Normal;
    this.stateTime = 0;
    this.health = this.maxHealth;
    this.stamina = 100;
    this.daze = this.koMeter = this.koTimer = this.stunTimer = this.hitTimer = 0;
    this.invuln = 0;
    this.action = null;
    this.buffer = null;
    this.blocking = false;
    this.dodgeTimer = 0;
    this.escape = 0;
    this.teeter = 0;
    this.combo = 0;
    this.exhausted = false;
    this.lastAttacker = null;
    this.grounded = true;
    for (const k of Object.keys(this.stats) as (keyof typeof this.stats)[]) this.stats[k] = 0;
    this.rig.resetPose();
    this.animator.reset();
    this.animator.update(0);
    this.rig.snapVelocities();
    this.computeHurtboxes();
  }

  setState(next: FState): boolean {
    if (next === this.state && next !== FState.Hit && next !== FState.KO && next !== FState.Thrown && next !== FState.Stunned) return false;
    if (!TRANSITIONS[this.state].includes(next)) return false;
    const from = this.state;
    this.state = next;
    this.stateTime = 0;
    this.settle = 0;
    // leaving control: cancel what we were doing
    if (!RULES[next].attack) {
      this.action = null;
      this.buffer = null;
    }
    if (!RULES[next].block) this.blocking = false;
    if (RULES[next].ragdoll && this.hold) this.releaseHold('drop');
    if (next === FState.KO) this.stats.kos++;
    this.ctx.events.emit('stateChange', { fighter: this, from, to: next });
    return true;
  }

  // ------------------------------------------------------------------ frames
  aimQuat(out: THREE.Quaternion, pitchScale = 1) {
    _e.set(this.pitch * pitchScale, this.yaw, 0, 'YXZ');
    return out.setFromEuler(_e);
  }
  eye(out: THREE.Vector3) {
    return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
  }
  forward(out: THREE.Vector3) {
    return forwardFromYaw(this.yaw, out);
  }
  /** Transform a point from the aim/body frame of an attack def to world space. */
  framePoint(frame: 'aim' | 'body', p: THREE.Vector3, out: THREE.Vector3) {
    if (frame === 'aim') {
      this.aimQuat(_q);
      return out.copy(p).applyQuaternion(_q).add(this.eye(_v2));
    }
    // body frame: pivot at hips, follows yaw fully and pitch partially (kick a guy on the floor)
    this.aimQuat(_q, 0.55);
    out.copy(p);
    out.y -= 0.9;
    out.applyQuaternion(_q);
    out.x += this.pos.x;
    out.y += this.pos.y + 0.9;
    out.z += this.pos.z;
    return out;
  }

  /** Current world position of the striking limb (or weapon tip) for the running action. */
  strikePoint(out: THREE.Vector3, tOverride?: number) {
    const a = this.action;
    if (!a) return out.set(0, -999, 0);
    const def = a.def;
    if (a.phase === 'hold') samplePath(def.path, 0, _v);
    else samplePath(def.path, tOverride ?? a.t, _v);
    if (def.limb === 'weapon' && this.hold?.kind === 'prop') {
      // weapon tip: grip at hand, extend along the swing axis
      this.weaponAxisAim(_v, _v2);
      const len = this.hold.prop.def.reach;
      _v.addScaledVector(_v2, len * 0.85);
    }
    return this.framePoint(def.frame, _v, out);
  }

  /** Axis of a held one-handed weapon in aim space given the hand position in aim space. */
  weaponAxisAim(handAim: THREE.Vector3, out: THREE.Vector3) {
    out.set(handAim.x - 0.05, handAim.y + 0.15, handAim.z - 0.25).normalize();
    if (!this.action || this.action.def.limb !== 'weapon') {
      // resting: blade up and slightly forward
      out.set(0.12, 0.9, -0.42).normalize();
    }
    return out;
  }

  // ------------------------------------------------------------------ update (before physics)
  fixedUpdate(dt: number) {
    this.lastDt = dt;
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
    this.stateTime += dt;
    const it = this.intent;
    const rule = this.rule;
    if (rule.control || this.state === FState.GettingUp || !rule.ragdoll) {
      this.yaw = it.yaw;
      this.pitch = it.pitch;
    }
    this.updateVitals(dt);
    this.updateStateMachine(dt);
    if (!this.rule.ragdoll) {
      this.updateCombatActions(dt);
      this.move(dt);
    } else {
      this.followRagdoll();
    }
    this.updateHold(dt);
    this.ragdoll.preStep();
  }

  private updateVitals(dt: number) {
    const t = this.ctx.time;
    if (this.invuln > 0) this.invuln -= dt;
    if (this.dodgeCooldown > 0) this.dodgeCooldown -= dt;
    if (this.ignoreCarrierTimer > 0) {
      this.ignoreCarrierTimer -= dt;
      if (this.ignoreCarrierTimer <= 0) this.ragdoll.setIgnoreFighter(null);
    }
    if (t - this.lastHitTime > 1.4 && this.state !== FState.Stunned) this.daze = Math.max(0, this.daze - 16 * dt);
    if (this.state !== FState.Stunned) this.koMeter = Math.max(0, this.koMeter - 10 * dt);
    let regen = 0;
    if (t - this.lastStaminaUse > 0.6) regen = 26;
    if (this.blocking) regen *= 0.4;
    if (this.hold?.kind === 'fighter') regen = 0;
    if (this.rule.ragdoll || this.state === FState.Stunned) regen = 32;
    this.stamina = Math.min(100, this.stamina + regen * dt);
    if (this.exhausted && this.stamina >= 30) this.exhausted = false;
    this.teeter = Math.max(0, this.teeter - dt * 2.5);
    if (t - this.lastLanded > 1.1) this.combo = 0;
  }

  useStamina(n: number) {
    this.stamina -= n;
    this.lastStaminaUse = this.ctx.time;
    if (this.stamina <= 0) {
      this.stamina = 0;
      if (!this.exhausted) {
        this.exhausted = true;
        this.ctx.events.emit('exhausted', { fighter: this });
      }
    }
  }

  private updateStateMachine(dt: number) {
    switch (this.state) {
      case FState.Hit:
        this.hitTimer -= dt;
        if (this.hitTimer <= 0) this.setState(FState.Normal);
        break;
      case FState.Stunned:
        this.stunTimer -= dt;
        if (this.stunTimer <= 0) {
          this.daze = 0;
          this.koMeter = 0;
          this.setState(FState.Normal);
        }
        break;
      case FState.KO:
        this.koTimer -= dt;
        // normally wait for the body to settle; never stay down forever if it keeps jittering
        if (!this.heldBy && ((this.koTimer <= 0 && this.settle > 0.25) || this.koTimer < -2.5)) this.beginGetUp();
        break;
      case FState.Grabbed:
      case FState.Carried: {
        // safety: the holder must still be holding us
        const h = this.heldBy?.hold;
        if (!this.heldBy || !h || h.kind !== 'fighter' || h.target !== this) {
          this.heldBy = null;
          this.ragdoll.releaseKinematic();
          this.ragdoll.setIgnoreFighter(null);
          this.setState(this.koTimer > 0 ? FState.KO : FState.Thrown);
          break;
        }
        this.koTimer -= dt;
        if (this.koTimer <= 0) {
          // awake: struggle to escape
          this.escape += this.intent.mash * (this.isPlayer ? 0.085 : 0.075) + dt * 0.07;
          if (this.escape >= 1 && this.heldBy) this.heldBy.releaseHold('escape');
        }
        break;
      }
      case FState.Thrown:
        if (this.koTimer > 0) this.koTimer -= dt;
        if (this.stateTime > 0.45 && this.settle > 0.3) {
          if (this.koTimer > 0.2) this.setState(FState.KO);
          else this.beginGetUp();
        }
        // safety net: never stay thrown forever
        if (this.stateTime > 6) this.beginGetUp();
        break;
      case FState.GettingUp:
        if (this.stateTime >= this.getUpDuration) {
          this.setState(FState.Normal);
          this.invuln = 0.35;
        }
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ combat actions
  private buttonFor(b: ActionInstance['button']): Btn {
    const it = this.intent;
    switch (b) {
      case 'punchL':
      case 'swing':
      case 'shove':
        return it.punchL;
      case 'punchR':
        return it.punchR;
      case 'throw':
        // throw may be bound to either mouse button depending on hold mode
        return this.throwButton;
      case 'kick':
        return it.kick;
    }
  }
  private throwButton: Btn = this.intent.punchR;

  private updateCombatActions(dt: number) {
    const it = this.intent;
    const rule = this.rule;
    const t = this.ctx.time;

    // --- block
    const wantBlock = it.block && rule.block && !this.exhausted && (!this.hold || this.hold.kind === 'prop') && this.dodgeTimer <= 0;
    if (wantBlock && !this.blocking) {
      this.blocking = true;
      this.blockStart = t;
      if (this.action?.phase === 'hold') this.action = null;
    } else if (!wantBlock) this.blocking = false;

    // --- dodge
    if (this.dodgeTimer > 0) this.dodgeTimer -= dt;
    if (it.dodge && rule.control && this.state === FState.Normal && this.dodgeCooldown <= 0 && this.grounded && this.stamina >= 12 && !this.exhausted && this.hold?.kind !== 'fighter') {
      this.useStamina(14);
      this.dodgeTimer = 0.24;
      this.dodgeCooldown = 0.55;
      this.invuln = Math.max(this.invuln, 0.22);
      forwardFromYaw(this.yaw, _fwd);
      rightFromYaw(this.yaw, _right);
      this.dodgeDir.set(0, 0, 0).addScaledVector(_right, it.moveX).addScaledVector(_fwd, it.moveZ);
      if (this.dodgeDir.lengthSq() < 0.01) this.dodgeDir.copy(_fwd).negate();
      this.dodgeDir.normalize();
      if (this.action?.phase === 'hold') this.action = null;
      this.ctx.events.emit('dodge', { fighter: this });
    }

    // --- buffer presses
    const pressed: 'punchL' | 'punchR' | 'kick' | null = it.punchL.pressed ? 'punchL' : it.punchR.pressed ? 'punchR' : it.kick.pressed ? 'kick' : null;
    if (pressed) this.buffer = { button: pressed, time: t };
    if (this.buffer && t - this.buffer.time > 0.22) this.buffer = null;

    // --- running action
    const a = this.action;
    if (a) {
      if (a.phase === 'hold') {
        a.holdTime += dt;
        const btn = this.buttonFor(a.button);
        if (a.heavy && a.holdTime > 0.17 && this.stamina > 0) this.useStamina(3 * dt);
        if (!btn.down || a.holdTime > AUTO_RELEASE || this.exhausted) this.releaseAction(a);
      } else {
        const prevT = a.t;
        a.t += dt;
        // lunge forward at the start of the strike
        if (a.t < 0.14 && a.def.lunge > 0) {
          forwardFromYaw(this.yaw, _fwd);
          const l = (a.def.lunge / 0.14) * (this.grounded ? 1 : 0.3);
          this.kb.addScaledVector(_fwd, l * dt * 9);
        }
        // throws/shoves fire at a precise moment of the strike
        if ((a.button === 'throw' || a.button === 'shove') && prevT < a.def.active[0] && a.t >= a.def.active[0]) this.fireRelease(a);
        if (a.done) this.action = null;
      }
    }

    // --- start / chain
    const canStart = rule.attack && !this.blocking && this.dodgeTimer <= 0 && !this.exhausted;
    if (canStart && this.buffer) {
      const cur = this.action;
      const chain = !cur || (cur.phase === 'strike' && cur.t >= cur.def.cancelAt);
      if (chain) {
        const started = this.startAction(this.buffer.button);
        if (started) this.buffer = null;
      }
    }
  }

  private startAction(button: 'punchL' | 'punchR' | 'kick'): boolean {
    const h = this.hold;
    let inst: ActionInstance | null = null;
    if (!h) {
      const pair = BUTTON_ATTACKS[button];
      inst = new ActionInstance(button, pair.quick, pair.heavy);
    } else if (h.kind === 'prop') {
      if (button === 'kick') inst = new ActionInstance('kick', ATTACKS.kick, ATTACKS.spartaKick);
      else if (button === 'punchL' && !h.twoHanded) inst = new ActionInstance('swing', ATTACKS.swing, ATTACKS.swing);
      else {
        this.throwButton = button === 'punchL' ? this.intent.punchL : this.intent.punchR;
        inst = new ActionInstance('throw', THROW_DEF, THROW_DEF);
      }
    } else if (h.kind === 'fighter') {
      if (button === 'kick') return false;
      if (button === 'punchL' && h.mode === 'drag') inst = new ActionInstance('shove', ATTACKS.shove, ATTACKS.shove);
      else {
        this.throwButton = button === 'punchL' ? this.intent.punchL : this.intent.punchR;
        inst = new ActionInstance('throw', THROW_DEF, THROW_DEF);
      }
    }
    if (!inst) return false;
    this.action = inst;
    // a quick tap that was already released before this step still counts
    const btn = this.buttonFor(inst.button);
    if (!btn.down) this.releaseAction(inst);
    return true;
  }

  private releaseAction(a: ActionInstance) {
    if (a.phase !== 'hold') return;
    const charging = a.holdTime;
    a.release();
    if (a.button === 'throw' || a.button === 'shove' || a.button === 'swing') {
      a.charge = clamp01(charging / 0.75);
      // swings always use the same path; charge scales power
      if (a.button === 'swing' && a.charge > 0.2) a.def = ATTACKS.swing;
    }
    const cost = a.def.stamina * (a.charge > 0 ? 1 + a.charge * 0.4 : 1);
    this.useStamina(cost);
    const heavy = a.def === a.heavy && a.heavy !== a.quick ? true : a.charge > 0.5;
    this.ctx.events.emit('whoosh', { fighter: this, pos: this.eye(new THREE.Vector3()), heavy, kind: a.def.kind });
  }

  /** Throw / shove moment. */
  private fireRelease(a: ActionInstance) {
    const h = this.hold;
    if (!h) return;
    if (a.button === 'shove' && h.kind === 'fighter') {
      const victim = h.target;
      forwardFromYaw(this.yaw, _fwd);
      const v = _v.copy(_fwd).multiplyScalar(7.5 + a.charge * 4).add(this.vel);
      v.y = 2.2;
      this.releaseHold('throw', v);
      victim.lastAttacker = { by: this, cause: 'pushed', time: this.ctx.time };
      return;
    }
    if (a.button !== 'throw') return;
    const v = this.throwVelocity(a.charge, _v);
    const speed = v.length();
    if (h.kind === 'fighter') {
      const victim = h.target;
      this.stats.throws++;
      this.releaseHold('throw', v);
      victim.lastAttacker = { by: this, cause: 'thrown', time: this.ctx.time };
      this.ctx.events.emit('throwBody', { attacker: this, victim, speed });
    } else {
      const prop = h.prop;
      const power = (0.4 + 0.6 * a.charge) * (this.exhausted ? 0.6 : 1);
      this.hold = null;
      rightFromYaw(this.yaw, _right);
      const spin = _v2.copy(_right).multiplyScalar(-(prop.def.spin ?? 7) * (0.5 + power));
      this.ctx.props.release(prop, v, spin, this);
      this.stats.propsThrown++;
      this.ctx.events.emit('throwProp', { fighter: this, prop, speed });
    }
  }

  /**
   * Release velocity of whatever we hold for a given charge (0..1). Shared by
   * the actual throw and the aiming arc preview, so the preview never lies.
   */
  throwVelocity(charge: number, out: THREE.Vector3) {
    const h = this.hold;
    out.set(0, 0, 0);
    if (!h) return out;
    const power = (0.4 + 0.6 * charge) * (this.exhausted ? 0.6 : 1);
    this.aimQuat(_tq);
    const dir = _tv.set(0, 0, -1).applyQuaternion(_tq);
    if (h.kind === 'fighter') {
      // throw a body: mostly forward with a lob
      dir.y = clamp(dir.y + 0.28, 0.08, 0.75);
      dir.normalize();
      const speed = ((7.5 + 10.5 * power) / Math.sqrt(h.target.massMul)) * (h.mode === 'drag' ? 0.8 : 1);
      out.copy(dir).multiplyScalar(speed);
      out.x += this.vel.x * 0.9;
      out.z += this.vel.z * 0.9;
    } else {
      dir.y += 0.07;
      dir.normalize();
      const massF = clamp(1.7 / Math.sqrt(Math.max(h.prop.def.mass, 0.3)), 0.32, 1.3);
      out.copy(dir).multiplyScalar((9 + 15 * power) * massF).add(this.vel);
    }
    return out;
  }

  // ------------------------------------------------------------------ movement
  private move(dt: number) {
    const it = this.intent;
    const rule = this.rule;
    const t = this.ctx.time;
    forwardFromYaw(this.yaw, _fwd);
    rightFromYaw(this.yaw, _right);
    let wx = 0;
    let wz = 0;
    if (rule.control && this.ctx.live) {
      wx = _right.x * it.moveX + _fwd.x * it.moveZ;
      wz = _right.z * it.moveX + _fwd.z * it.moveZ;
      const l = Math.hypot(wx, wz);
      if (l > 1) {
        wx /= l;
        wz /= l;
      }
      if (this.state === FState.Stunned) {
        // drunken steering: the input direction wobbles and drifts
        const ang = noise1(t * 1.4, this.index * 7) * 1.2;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const nx = wx * c - wz * s;
        const nz = wx * s + wz * c;
        wx = nx + noise1(t * 0.9, 3 + this.index) * 0.55;
        wz = nz + noise1(t * 0.8, 9 + this.index) * 0.55;
      }
    }
    let speed = WALK * this.def.stats.speed * rule.moveScale;
    const back = it.moveZ < -0.1;
    if (it.sprint && !back && !this.exhausted && this.state === FState.Normal && !this.blocking && it.moveZ > 0.2) {
      speed *= SPRINT_MUL;
      if (Math.hypot(wx, wz) > 0.3) this.useStamina(9 * dt);
    }
    if (back) speed *= 0.82;
    if (this.blocking) speed *= 0.5;
    if (this.action) speed *= this.action.phase === 'hold' ? 0.6 : 0.55;
    if (this.hold?.kind === 'fighter') speed *= this.hold.mode === 'carry' ? 0.66 / Math.sqrt(this.hold.target.massMul) : 0.72;
    else if (this.hold?.kind === 'prop') speed *= clamp(1.08 - this.hold.prop.def.mass * 0.018, 0.6, 1);
    if (this.exhausted) speed *= 0.75;

    let tx = wx * speed;
    let tz = wz * speed;
    if (this.dodgeTimer > 0) {
      tx = this.dodgeDir.x * 10;
      tz = this.dodgeDir.z * 10;
    }
    const accel = this.dodgeTimer > 0 ? 80 : this.grounded ? 44 : 9;
    const dvx = tx - this.vel.x;
    const dvz = tz - this.vel.z;
    const dl = Math.hypot(dvx, dvz);
    const maxDv = accel * dt;
    if (dl > maxDv) {
      this.vel.x += (dvx / dl) * maxDv;
      this.vel.z += (dvz / dl) * maxDv;
    } else {
      this.vel.x = tx;
      this.vel.z = tz;
    }

    // vertical
    if (this.grounded && this.vel.y <= 0) this.vel.y = -1.5;
    else this.vel.y -= GRAVITY * dt;
    if (it.jump && rule.control && this.grounded && this.state === FState.Normal && this.hold?.kind !== 'fighter' && this.ctx.live) {
      this.vel.y = JUMP_V;
      this.grounded = false;
      this.ctx.events.emit('jump', { fighter: this });
    }

    // knockback decays with friction on the ground
    const kd = this.grounded ? Math.exp(-6.2 * dt) : Math.exp(-0.4 * dt);
    this.kb.x *= kd;
    this.kb.z *= kd;
    const kbSpeed = Math.hypot(this.kb.x, this.kb.z);

    // voluntary part with edge assist: you can't *walk* off the roof by accident
    let mx = this.vel.x * dt;
    let mz = this.vel.z * dt;
    if (this.grounded && this.dodgeTimer <= 0) {
      const nx = this.pos.x + mx;
      const nz = this.pos.z + mz;
      if (!walkable(nx, nz) && walkable(this.pos.x, this.pos.z)) {
        if (walkable(nx, this.pos.z)) mz = 0;
        else if (walkable(this.pos.x, nz)) mx = 0;
        else {
          mx = 0;
          mz = 0;
        }
        if (this.teeter < 0.5) this.ctx.events.emit('teeter', { fighter: this });
        this.teeter = 1;
        this.vel.x *= 0.5;
        this.vel.z *= 0.5;
      }
    } else if (this.grounded && this.dodgeTimer > 0) {
      // dodging toward the void: stop at the edge too
      const nx = this.pos.x + mx;
      const nz = this.pos.z + mz;
      if (!walkable(nx, nz)) {
        mx = 0;
        mz = 0;
        this.dodgeTimer = 0;
      }
    }

    const desired = _v.set(mx + this.kb.x * dt, this.vel.y * dt, mz + this.kb.z * dt);
    const heldProp = this.hold?.kind === 'prop' ? this.hold.prop : null;
    this.kcc.computeColliderMovement(
      this.collider,
      desired,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups(this.layer, G.STATIC | G.PROP | (this.index === 0 ? G.F1 : G.F0)),
      (c) => {
        const o = this.ctx.physics.owner(c);
        if (!o) return true;
        if (o.kind === 'prop') return o.ref !== heldProp && !o.ref.heldBy && o.ref.def.mass >= 7;
        return true;
      },
    );
    const mv = this.kcc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.kcc.computedGrounded();

    // collisions: railings break, low walls trip you over
    if (kbSpeed > TRIP_KB) {
      for (let i = 0; i < this.kcc.numComputedCollisions(); i++) {
        const c = this.kcc.computedCollision(i);
        if (!c || !c.collider) continue;
        const o = this.ctx.physics.owner(c.collider);
        const nrm = c.normal1;
        if (Math.abs(nrm.y) > 0.5) continue;
        // only if we're actually being pushed into it
        const into = -(nrm.x * this.kb.x + nrm.z * this.kb.z) / kbSpeed;
        if (into < 0.45) continue;
        if (o?.kind === 'railing' && !o.ref.broken) {
          o.ref.break(_v2.set(this.kb.x * 30, 0, this.kb.z * 30));
          this.ctx.events.emit('railingBreak', { pos: new THREE.Vector3(c.witness1.x, c.witness1.y, c.witness1.z) });
          this.launch(_v2.set(this.kb.x * 1.1, 2.5, this.kb.z * 1.1), 0.15);
          return;
        }
        if (o?.kind === 'static' && c.witness1.y < this.pos.y + 0.75 && this.ctx.arena.distanceToAnyEdge(c.witness1.x, c.witness1.z) < 0.9) {
          // trip over the parapet: flip over it!
          this.launch(_v2.set(this.kb.x * 1.05, 3.4 + kbSpeed * 0.12, this.kb.z * 1.05), 0.15);
          return;
        }
        if (o?.kind === 'static' && kbSpeed > 7.2) {
          // cartoon wall splat: bounce off and crumple
          this.ctx.events.emit('bodyImpact', { fighter: this, pos: new THREE.Vector3(c.witness1.x, c.witness1.y, c.witness1.z), speed: kbSpeed, part: RP.chest });
          this.health = Math.max(1, this.health - 5);
          this.launch(_v2.set(-this.kb.x * 0.25, 2, -this.kb.z * 0.25), 0.8);
          return;
        }
      }
    }

    this.pos.x += mv.x;
    this.pos.y += mv.y;
    this.pos.z += mv.z;
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y + CAPSULE_CY, z: this.pos.z });

    if (this.grounded) {
      if (!wasGrounded && this.airTime > 0.25) this.ctx.events.emit('land', { fighter: this, pos: this.pos.clone(), speed: -this.vel.y });
      this.airTime = 0;
      if (this.vel.y < 0) this.vel.y = -1.5;
    } else {
      this.airTime += dt;
      if (mv.y > desired.y + 1e-3 && this.vel.y > 0) this.vel.y = 0; // bonked head
    }

    // footsteps
    const sp = Math.hypot(mv.x, mv.z);
    if (this.grounded && sp > 0.0005) {
      this.stepDist += sp;
      const stride = 0.62 + Math.hypot(this.vel.x, this.vel.z) * 0.07;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        this.ctx.events.emit('footstep', { fighter: this, pos: this.pos.clone(), intensity: clamp(sp / dt / 6, 0.2, 1.2) });
      }
    }

    if (this.pos.y < FALL_Y) this.startFalling();
  }

  // ------------------------------------------------------------------ ragdoll states
  /** Go full ragdoll with an initial velocity (THROWN state). */
  launch(vel: THREE.Vector3, koExtra = 0, cap = MAX_LAUNCH) {
    if (this.state === FState.Falling) return;
    const h = Math.hypot(vel.x, vel.z);
    if (h > cap) {
      vel.x *= cap / h;
      vel.z *= cap / h;
    }
    this.startRagdoll(vel, 0.35);
    this.koTimer = Math.max(this.koTimer, koExtra);
    this.launchTime = this.ctx.time;
    this.setState(FState.Thrown);
  }

  startRagdoll(extraVel: THREE.Vector3, muscle: number) {
    if (this.hold) this.releaseHold('drop');
    this.action = null;
    this.blocking = false;
    if (!this.ragdoll.active) {
      this.rig.root.updateMatrixWorld(true);
      // include the body's own momentum (own temp: callers often pass the shared scratch vectors)
      _rv.copy(this.vel).add(this.kb);
      _rv.y = Math.max(_rv.y, -4);
      _rv.add(extraVel);
      this.ragdoll.activate(_rv, this.lastDt);
      this.collider.setEnabled(false);
    } else {
      this.ragdoll.addVelocity(extraVel);
    }
    this.ragdoll.setMuscle(muscle);
    this.vel.set(0, 0, 0);
    this.kb.set(0, 0, 0);
  }

  private followRagdoll() {
    // keep the (disabled) capsule roughly with the pelvis so systems querying `pos` behave
    this.ragdoll.pelvisPos(_v);
    this.pos.set(_v.x, _v.y - this.rig.dims.pelvisY * 0.5, _v.z);
    this.ragdoll.setMuscle(this.state === FState.KO || this.koTimer > 0 ? 0.04 : this.state === FState.Falling ? 0.35 : this.state === FState.Thrown ? 0.25 : 0.45);
  }

  private beginGetUp() {
    if (!this.ragdoll.active) {
      this.setState(FState.GettingUp);
      return;
    }
    const pelvis = this.ragdoll.pelvisPos(_v2);
    // find the ground under the pelvis
    const hit = this.ctx.physics.raycast(_v.set(pelvis.x, pelvis.y + 0.6, pelvis.z), tmpV1.set(0, -1, 0), 3, groups(G.ALL, G.STATIC));
    const gy = hit ? hit.point.y : Math.max(0, pelvis.y - 0.5);
    const yaw = this.ragdoll.torsoYaw();
    // capture the ragdoll pose, then hand control back to animation
    this.ragdoll.applyToRig(1);
    this.pos.set(pelvis.x, gy, pelvis.z);
    // push out of walls a bit by clamping onto the roof
    if (this.pos.y > -0.5 && this.pos.y < 0.5) {
      this.pos.x = clamp(this.pos.x, ROOF.minX + 0.45, this.pos.x > ROOF.maxX - 0.6 && Math.abs(this.pos.z) < 0.4 ? ROOF.maxX + 2.6 : ROOF.maxX - 0.45);
      this.pos.z = clamp(this.pos.z, ROOF.minZ + 0.45, ROOF.maxZ - 0.45);
    }
    // never stand up inside the opponent or a wall
    const opp = this.opponent;
    if (opp && !opp.rule.ragdoll) {
      const dx = this.pos.x - opp.pos.x;
      const dz = this.pos.z - opp.pos.z;
      const dd = Math.hypot(dx, dz);
      if (dd < 0.8) {
        forwardFromYaw(opp.yaw, _fwd);
        const nx = dd > 0.05 ? dx / dd : _fwd.x;
        const nz = dd > 0.05 ? dz / dd : _fwd.z;
        this.pos.x = opp.pos.x + nx * 0.8;
        this.pos.z = opp.pos.z + nz * 0.8;
      }
    }
    this.findFreeSpot();
    // the player keeps looking where the camera looks; the AI faces where it landed
    const faceYaw = this.isPlayer ? this.intent.yaw : yaw;
    this.yaw = this.prevYaw = faceYaw;
    this.intent.yaw = faceYaw;
    this.animator.captureForGetUp(this.pos, faceYaw);
    this.ragdoll.deactivate();
    this.collider.setEnabled(true);
    this.body.setTranslation({ x: this.pos.x, y: this.pos.y + CAPSULE_CY, z: this.pos.z }, true);
    this.prevPos.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.kb.set(0, 0, 0);
    this.escape = 0;
    if (this.health <= 0) this.health = 35;
    this.getUpDuration = this.heldBy ? 0.45 : 0.75 + (1 - this.health / this.maxHealth) * 0.35;
    this.setState(FState.GettingUp);
  }

  /** Nudge `pos` toward the roof center until the capsule doesn't overlap static geometry. */
  private findFreeSpot() {
    const world = this.ctx.physics.world;
    const shape = new RAPIER.Capsule(CAPSULE_HH, CAPSULE_R * 0.95);
    const filter = groups(this.layer, G.STATIC);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    for (let i = 0; i < 16; i++) {
      let hit = false;
      world.intersectionsWithShape({ x: this.pos.x, y: this.pos.y + CAPSULE_CY + 0.03, z: this.pos.z }, rot, shape, () => {
        hit = true;
        return false;
      }, undefined, filter, this.collider);
      if (!hit) return;
      const dx = -this.pos.x;
      const dz = -this.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      this.pos.x += (dx / l) * 0.18;
      this.pos.z += (dz / l) * 0.18;
    }
  }

  /** Segment of the held weapon (grip → tip) in world space at action time t. */
  weaponSegment(t: number, outGrip: THREE.Vector3, outTip: THREE.Vector3) {
    const a = this.action;
    if (!a || this.hold?.kind !== 'prop') return false;
    samplePath(a.def.path, t, _v);
    this.weaponAxisAim(_v, _v2);
    const len = this.hold.prop.def.reach;
    tmpV5.copy(_v).addScaledVector(_v2, len);
    this.framePoint('aim', _v, outGrip);
    this.framePoint('aim', tmpV5, outTip);
    return true;
  }

  startFalling() {
    if (this.state === FState.Falling) return;
    if (!this.ragdoll.active) this.startRagdoll(_v.set(0, 0, 0), 0.4);
    if (this.heldBy) this.heldBy.hold = null;
    this.heldBy = null;
    this.ragdoll.releaseKinematic();
    const la = this.lastAttacker;
    const recent = la && this.ctx.time - la.time < 4.5;
    this.setState(FState.Falling);
    this.ctx.events.emit('fall', { fighter: this, cause: recent ? la!.cause : 'self', by: recent ? la!.by : null, prop: recent ? la!.prop : undefined });
  }

  // ------------------------------------------------------------------ after physics
  postPhysics(dt: number) {
    this.ragdoll.postStep();
    if (this.ragdoll.active) {
      const s = this.ragdoll.speed();
      this.settle = s < 1.1 ? this.settle + dt : 0;
      this.ragdoll.pelvisPos(_v);
      if (_v.y < FALL_Y && this.state !== FState.Falling) this.startFalling();
      // falling: flail arms & legs like a cartoon
      if (this.state === FState.Falling && this.stateTime < 4) {
        const k = 0.9;
        for (const p of [RP.foreArmL, RP.foreArmR, RP.shinL, RP.shinR]) {
          this.ragdoll.applyImpulse(p, _v2.set((Math.random() - 0.5) * k, (Math.random() - 0.3) * k, (Math.random() - 0.5) * k));
        }
      }
      this.ragdoll.applyToRig(1);
      this.rig.stars.visible = this.koTimer > 0 && this.state !== FState.Falling;
      this.animator.updateFace(dt);
    } else {
      this.animator.update(dt);
    }
    this.rig.trackVelocities();
    this.computeHurtboxes();
  }

  computeHurtboxes() {
    const r = this.rig;
    const d = r.dims;
    const hb = this.hurtboxes;
    const head = r.bones[B.head];
    hb[0].a.set(0, d.headCY, 0).applyMatrix4(head.matrixWorld);
    hb[0].b.copy(hb[0].a);
    hb[0].r = d.headR + 0.04;
    hb[1].a.set(0, -0.06, 0).applyMatrix4(r.bones[B.pelvis].matrixWorld);
    hb[1].b.set(0, 0.26, 0).applyMatrix4(r.bones[B.chest].matrixWorld);
    hb[1].r = d.torsoW * 0.52 + 0.03;
    const seg = (i: number, a: number, b: number, rad: number) => {
      hb[i].a.setFromMatrixPosition(r.bones[a].matrixWorld);
      hb[i].b.setFromMatrixPosition(r.bones[b].matrixWorld);
      hb[i].r = rad;
    };
    seg(2, B.thighL, B.shinL, 0.11);
    seg(3, B.shinL, B.footL, 0.09);
    seg(4, B.thighR, B.shinR, 0.11);
    seg(5, B.shinR, B.footR, 0.09);
    seg(6, B.upperArmL, B.handL, 0.085);
    seg(7, B.upperArmR, B.handR, 0.085);
  }

  // ------------------------------------------------------------------ render
  render(alpha: number) {
    if (this.ragdoll.active) {
      this.ragdoll.applyToRig(alpha);
      return;
    }
    const root = this.rig.root;
    root.position.lerpVectors(this.prevPos, this.pos, alpha);
    root.position.y += this.animator.rootOffsetY;
    const yaw = this.prevYaw + wrapAngle(this.yaw - this.prevYaw) * alpha;
    root.quaternion.setFromAxisAngle(UP, yaw + this.animator.rootYawOffset);
    root.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------------ hits
  /** Apply an incoming hit. Returns the resolved event (or null if ignored). */
  takeHit(h: IncomingHit): HitEvent | null {
    if (this.state === FState.Falling) return null;
    if (this.invuln > 0 && h.kind !== 'explosion') return null;
    const t = this.ctx.time;
    const ev: HitEvent = {
      attacker: h.attacker,
      victim: this,
      point: h.point.clone(),
      dir: h.dir.clone(),
      kind: h.kind,
      zone: h.zone,
      damage: 0,
      power: 0,
      heavy: h.heavy,
      blocked: false,
      perfect: false,
      prop: h.prop,
      result: 'hit',
      attackName: h.attackName,
    };

    // ---- ragdolled bodies: just physics + a bit of damage
    if (this.rule.ragdoll) {
      const dmg = h.damage * 0.5 * this.def.stats.toughness;
      this.health = Math.max(0, this.health - dmg);
      ev.damage = dmg;
      ev.power = clamp(h.knockback / 8, 0.2, 2);
      const part = h.part ?? RP.chest;
      const imp = _v.copy(h.dir).multiplyScalar(h.knockback * 9 * (h.kind === 'kick' ? 1.6 : 1)).add(_v2.set(0, h.lift * 6 + 8, 0));
      if (this.state === FState.Carried || this.state === FState.Grabbed) {
        // smack the guy you are carrying? nah: hitting a carried body makes the carrier drop it
        this.heldBy?.releaseHold('drop');
      }
      this.ragdoll.applyImpulse(part, imp, h.point);
      this.ragdoll.applyImpulse(RP.pelvis, _v.multiplyScalar(0.5));
      ev.result = 'launch';
      this.recordAttacker(h);
      this.lastHitTime = t;
      return ev;
    }

    // ---- blocking
    forwardFromYaw(this.yaw, _fwd);
    const facing = -(_fwd.x * h.dir.x + _fwd.z * h.dir.z);
    let damage = h.damage;
    let kb = h.knockback;
    let daze = h.daze;
    let lift = h.lift;
    if (this.blocking && !h.unblockable && facing > 0.3) {
      const perfect = t - this.blockStart < 0.2;
      ev.blocked = true;
      this.stats.blocks++;
      if (perfect && h.attacker && (h.kind === 'punch' || h.kind === 'kick' || h.kind === 'swing')) {
        ev.perfect = true;
        ev.result = 'blocked';
        h.attacker.stagger(0.55, h.dir.clone().negate());
        this.ctx.events.emit('parry', { attacker: h.attacker, victim: this, point: ev.point });
        this.kb.addScaledVector(h.dir, 1.2);
        return ev;
      }
      damage *= 0.15;
      kb *= 0.45;
      lift *= 0.3;
      daze *= 0.2;
      this.useStamina(h.damage * 1.5 + 7);
      ev.result = 'blocked';
      if (this.stamina <= 0) {
        // guard broken!
        this.blocking = false;
        ev.result = 'guardbreak';
        daze = 0;
        this.stunTimer = 1.8;
        this.setState(FState.Stunned);
      }
    }

    // ---- damage & knockback scaling
    damage *= this.def.stats.toughness;
    if (h.zone === 'legs') damage *= 0.8;
    this.health = Math.max(0, this.health - damage);
    ev.damage = damage;
    const hurt = 1 - this.health / this.maxHealth;
    // Smash-style: the more beaten up you are, the further you fly
    kb *= (0.72 + hurt * 1.15) / Math.sqrt(this.massMul);
    const cap = 8.5 + hurt * 6;
    ev.power = clamp(kb / 7, 0.15, 2);
    this.lastHitTime = t;
    this.recordAttacker(h);

    if (this.hold?.kind === 'fighter' && !ev.blocked) this.releaseHold('drop');
    else if (this.hold?.kind === 'prop' && h.heavy && !ev.blocked) this.releaseHold('drop');
    if (!ev.blocked && this.action) this.action = null;

    this.animator.hitReact(h.dir, h.zone, ev.power, h.heavy);

    // ---- KO by health
    if (this.health <= 0) {
      this.koTimer = 6.2;
      this.launch(_v.copy(h.dir).multiplyScalar(Math.max(kb, 4)).setY(lift + 2.5), 6.2, cap);
      this.setState(FState.KO);
      ev.result = 'ko';
      return ev;
    }

    // ---- stun / KO meters
    if (ev.result !== 'guardbreak') {
      const comboMul = 1 + Math.min(4, h.attacker?.combo ?? 0) * 0.1;
      if (this.state === FState.Stunned) {
        this.koMeter += daze * comboMul + (h.heavy ? 22 : 0);
        if (this.koMeter >= 48 || (h.heavy && kb > 6)) {
          this.koTimer = 3.8 + hurt * 2.6;
          this.launch(_v.copy(h.dir).multiplyScalar(Math.max(kb, 3.5)).setY(lift + 2), this.koTimer, cap);
          this.setState(FState.KO);
          ev.result = 'ko';
          return ev;
        }
        this.stunTimer = Math.max(this.stunTimer, 0.6);
      } else {
        this.daze += daze * comboMul;
        if (this.daze >= 100) {
          this.daze = 0;
          this.koMeter = 0;
          this.stunTimer = 3.0 + hurt * 1.4;
          ev.result = 'stun';
        }
      }
    }

    // ---- physical reaction
    if (kb >= RAGDOLL_KB && !ev.blocked) {
      this.launch(_v.copy(h.dir).multiplyScalar(kb).setY(Math.max(lift, 2.2)), ev.result === 'stun' ? 0.6 : 0, cap);
      if (ev.result === 'stun') this.stunTimer = 0;
      ev.result = ev.result === 'stun' ? 'stun' : 'launch';
      return ev;
    }
    this.kb.addScaledVector(h.dir, kb);
    if (lift > 1.5 && !ev.blocked) {
      this.vel.y = Math.max(this.vel.y, lift);
      this.grounded = false;
    }
    if (ev.result === 'stun') {
      this.setState(FState.Stunned);
    } else if (this.state !== FState.Stunned && ev.result !== 'guardbreak') {
      this.hitTimer = ev.blocked ? 0.12 : 0.16 + damage * 0.016 + (h.heavy ? 0.18 : 0);
      if (this.state === FState.GettingUp || this.state === FState.Normal || this.state === FState.Hit) this.setState(FState.Hit);
    }
    return ev;
  }

  /** Short stagger (parried / escape). */
  stagger(time: number, dir: THREE.Vector3) {
    if (this.rule.ragdoll || this.state === FState.Falling) return;
    this.action = null;
    this.hitTimer = time;
    this.kb.addScaledVector(dir, 2.2);
    this.animator.hitReact(dir, 'head', 0.8, true);
    if (this.state === FState.Stunned) return;
    this.setState(FState.Hit);
  }

  private recordAttacker(h: IncomingHit) {
    if (!h.attacker && h.kind !== 'explosion') return;
    const cause: FallCause = h.kind === 'prop' ? 'prop' : h.kind === 'explosion' ? 'explosion' : 'pushed';
    this.lastAttacker = { by: h.attacker, cause, time: this.ctx.time, prop: h.prop?.def.name };
  }

  // ------------------------------------------------------------------ holding
  canGrab(target: Fighter) {
    return RULES[target.state].grabbable && !target.heldBy && !this.hold && this.rule.interact && !this.exhausted;
  }

  grabFighter(target: Fighter) {
    if (!this.canGrab(target)) return false;
    if (!target.ragdoll.active) target.startRagdoll(_v.set(0, 0, 0), 0.45);
    target.heldBy = this;
    target.escape = target.koTimer > 0 ? 0 : 0.25;
    target.ragdoll.setIgnoreFighter(this.layer);
    target.ragdoll.setKinematic(RP.chest, true);
    target.setState(FState.Grabbed);
    this.hold = { kind: 'fighter', target, mode: 'drag', t: 0, lift: 0 };
    this.action = null;
    this.ctx.events.emit('grab', { attacker: this, victim: target });
    return true;
  }

  liftHeld() {
    const h = this.hold;
    if (!h || h.kind !== 'fighter' || h.mode !== 'drag') return false;
    if (this.stamina < 10) {
      this.ctx.events.emit('exhausted', { fighter: this });
      return false;
    }
    h.mode = 'carry';
    h.target.ragdoll.setKinematic(RP.pelvis, true);
    h.target.setState(FState.Carried);
    this.useStamina(8);
    this.ctx.events.emit('lift', { attacker: this, victim: h.target });
    return true;
  }

  pickUpProp(prop: Prop) {
    if (this.hold || !this.rule.interact) return false;
    if (!this.ctx.props.grab(prop, this)) return false;
    this.hold = { kind: 'prop', prop, twoHanded: prop.def.twoHanded };
    this.action = null;
    this.ctx.events.emit('pickup', { fighter: this, prop });
    return true;
  }

  /** Let go of whatever we hold. */
  releaseHold(mode: 'drop' | 'throw' | 'escape', vel?: THREE.Vector3) {
    const h = this.hold;
    if (!h) return;
    this.hold = null;
    if (this.action && (this.action.button === 'throw' || this.action.button === 'shove' || this.action.button === 'swing')) this.action = null;
    if (h.kind === 'prop') {
      const v = vel ?? _v.copy(this.vel);
      this.ctx.props.release(h.prop, v, _v2.set(0, 0, 0), null);
      if (mode === 'drop') this.ctx.events.emit('dropProp', { fighter: this, prop: h.prop });
      return;
    }
    const victim = h.target;
    victim.heldBy = null;
    victim.ragdoll.releaseKinematic();
    victim.ignoreCarrierTimer = 0.35;
    const v = vel ?? _v.copy(this.vel);
    if (mode === 'throw') {
      rightFromYaw(this.yaw, _right);
      victim.ragdoll.setVelocity(v, _v2.copy(_right).multiplyScalar(-5));
      victim.launchTime = this.ctx.time;
      victim.setState(FState.Thrown);
    } else if (mode === 'escape') {
      victim.ragdoll.setVelocity(_v.set(0, 1.5, 0));
      this.ctx.events.emit('escape', { victim, attacker: this });
      victim.escape = 0;
      victim.koTimer = 0;
      victim.beginGetUp();
      forwardFromYaw(this.yaw, _fwd);
      this.stagger(0.6, _fwd.clone().negate());
      this.kb.addScaledVector(_fwd, -3);
    } else {
      victim.ragdoll.setVelocity(v);
      if (victim.koTimer > 0) victim.setState(FState.KO);
      else victim.setState(FState.Thrown);
      this.ctx.events.emit('dropBody', { attacker: this, victim });
    }
  }

  private updateHold(dt: number) {
    const h = this.hold;
    if (!h) return;
    if (this.rule.ragdoll) {
      this.releaseHold('drop');
      return;
    }
    if (h.kind === 'prop') {
      if (h.prop.heldBy !== this) {
        this.hold = null;
        return;
      }
      this.computeHeldPropPose(_v, _q);
      this.ctx.props.drive(h.prop, _v, _q);
      return;
    }
    // fighter in our hands
    const victim = h.target;
    if (victim.state === FState.Falling || victim.heldBy !== this) {
      this.hold = null;
      return;
    }
    h.t += dt;
    const drain = (h.mode === 'carry' ? 6.5 : 2.5) * victim.massMul;
    this.useStamina(drain * dt);
    if (this.exhausted) {
      this.releaseHold('drop');
      return;
    }
    h.lift = h.mode === 'carry' ? Math.min(1, h.lift + dt / 0.35) : 0;
    this.computeCarryPose(victim, h.lift);
  }

  /** World pose of a held prop (grip at the right hand). */
  computeHeldPropPose(outPos: THREE.Vector3, outQuat: THREE.Quaternion) {
    const h = this.hold;
    if (!h || h.kind !== 'prop') return;
    const def = h.prop.def;
    const a = this.action;
    if (h.twoHanded) {
      // held in front with both hands, pulled back while charging a throw
      const p = _v2.set(0, -0.32, -0.62);
      if (a && a.button === 'throw') {
        // wind up over the head (keeps the view clear), then heave forward
        if (a.phase === 'hold') p.set(0, 0.2 + Math.min(a.holdTime, 0.6) * 0.08, -0.45);
        else p.set(0, -0.02, -0.85);
      }
      this.framePoint('aim', p, outPos);
      outQuat.setFromAxisAngle(UP, this.yaw);
      return;
    }
    let hand: THREE.Vector3;
    if (a && (a.button === 'swing' || a.button === 'throw')) {
      hand = samplePath(a.def.path, a.phase === 'hold' ? 0 : a.t, _v2);
    } else {
      hand = _v2.set(0.24, -0.27, -0.42);
    }
    const axis = this.weaponAxisAim(hand, tmpV1);
    if (a && a.button === 'throw') axis.set(0.1, 0.8, 0.5).normalize();
    _q2.setFromUnitVectors(UP, axis);
    this.aimQuat(_q);
    outQuat.copy(_q).multiply(_q2);
    // grip point → center
    this.framePoint('aim', hand, outPos);
    _v.copy(def.grip).applyQuaternion(outQuat);
    outPos.sub(_v);
  }

  private computeCarryPose(victim: Fighter, lift: number) {
    forwardFromYaw(this.yaw, _fwd);
    rightFromYaw(this.yaw, _right);
    const vd = victim.rig.dims;
    const yawQ = _q.setFromAxisAngle(UP, this.yaw);
    const bob = Math.sin(this.animator.phase * Math.PI * 2) * 0.04;
    // drag pose: chest held at hand height in front, victim facing us and leaning away
    const dragPos = _v.copy(this.pos).addScaledVector(_fwd, 0.72).addScaledVector(UP, 1.02).addScaledVector(_right, 0.05);
    const dragRot = _q2.setFromAxisAngle(UP, this.yaw + Math.PI).multiply(tmpQ.setFromAxisAngle(AXIS_X, 0.55));
    if (lift <= 0) {
      victim.ragdoll.driveKinematic(RP.chest, dragPos, dragRot);
      return;
    }
    // carry pose: body across the shoulders above the head, belly up
    const carryRot = tmpQ2.copy(yawQ).multiply(CARRY_BASIS);
    const anchor = tmpV2.copy(this.pos).addScaledVector(UP, this.eyeHeight + 0.38 + bob).addScaledVector(_fwd, 0.08);
    const pelvisPos = tmpV3.set(0, -vd.spine * 0.5, 0).applyQuaternion(carryRot).add(anchor);
    const chestPos = tmpV4.set(0, vd.spine, 0).applyQuaternion(carryRot).add(pelvisPos);
    const k = lift < 1 ? lift * lift * (3 - 2 * lift) : 1;
    chestPos.lerpVectors(dragPos, chestPos, k);
    const chestRot = tmpQ3.slerpQuaternions(dragRot, carryRot, k);
    pelvisPos.lerpVectors(tmpV5.set(0, -vd.spine, 0).applyQuaternion(chestRot).add(chestPos), pelvisPos, k);
    victim.ragdoll.driveKinematic(RP.chest, chestPos, chestRot);
    victim.ragdoll.driveKinematic(RP.pelvis, pelvisPos, chestRot);
  }
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpQ3 = new THREE.Quaternion();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpV4 = new THREE.Vector3();
const tmpV5 = new THREE.Vector3();

/** Can a fighter's feet stand here by walking? (roof interior or the plank) */
export function walkable(x: number, z: number) {
  const m = 0.28;
  if (x > ROOF.minX + m && x < ROOF.maxX - m && z > ROOF.minZ + m && z < ROOF.maxZ - m) return true;
  // the diving plank
  return x >= ROOF.maxX - 0.7 && x <= ROOF.maxX + 3.0 && Math.abs(z) <= 0.3;
}
