import * as THREE from 'three';
import { G, groups, Physics, RAPIER } from '../physics/Physics';
import { B, Rig } from './Rig';

/**
 * Physical ragdoll built from the rig's dimensions.
 *
 * - 11 rigid bodies created once and toggled with setEnabled() (no runtime allocation)
 * - spherical joints with angular motors = "muscle tone" (active ragdoll):
 *   strong when stunned/dragged, nearly limp when knocked out
 * - revolute elbows/knees with real joint limits
 * - pelvis/chest can be switched to kinematic to be carried or dragged
 * - render interpolation between physics steps
 */

export const RAGDOLL_PARTS = [
  { bone: B.pelvis, parent: -1, mass: 14 },
  { bone: B.chest, parent: 0, mass: 21 },
  { bone: B.head, parent: 1, mass: 6 },
  { bone: B.upperArmL, parent: 1, mass: 2.6 },
  { bone: B.foreArmL, parent: 3, mass: 2.4 },
  { bone: B.upperArmR, parent: 1, mass: 2.6 },
  { bone: B.foreArmR, parent: 5, mass: 2.4 },
  { bone: B.thighL, parent: 0, mass: 7 },
  { bone: B.shinL, parent: 7, mass: 4.5 },
  { bone: B.thighR, parent: 0, mass: 7 },
  { bone: B.shinR, parent: 9, mass: 4.5 },
] as const;

export const RP = { pelvis: 0, chest: 1, head: 2, upperArmL: 3, foreArmL: 4, upperArmR: 5, foreArmR: 6, thighL: 7, shinL: 8, thighR: 9, shinR: 10 } as const;

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _mi = new THREE.Matrix4();
const _v = new THREE.Vector3();

interface PartState {
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[];
  prevP: THREE.Vector3;
  prevQ: THREE.Quaternion;
  curP: THREE.Vector3;
  curQ: THREE.Quaternion;
  /** linear velocity of the previous step (pre-collision speed for impact damage) */
  prevVel: THREE.Vector3;
  /** short history: collision events arrive one step after the bounce */
  hist: THREE.Vector3[];
  histIdx: number;
}

export class Ragdoll {
  readonly parts: PartState[] = [];
  readonly joints: RAPIER.ImpulseJoint[] = [];
  active = false;
  private kinematic = new Set<number>();
  readonly membership: number;
  private baseFilter: number;
  private muscle = -1;

  constructor(
    physics: Physics,
    private rig: Rig,
    readonly index: 0 | 1,
    massScale: number,
    owner: unknown,
  ) {
    const d = rig.dims;
    this.membership = index === 0 ? G.R0 : G.R1;
    const otherF = index === 0 ? G.F1 : G.F0;
    const otherR = index === 0 ? G.R1 : G.R0;
    this.baseFilter = G.STATIC | G.PROP | otherF | otherR | G.HELD;
    const cg = groups(this.membership, this.baseFilter);
    const world = physics.world;
    const C = RAPIER.ColliderDesc;

    const shapes: ((m: number) => RAPIER.ColliderDesc[])[] = [
      // pelvis
      (m) => [C.roundCuboid(d.torsoW * 0.4, 0.09, d.torsoD * 0.38, 0.04).setTranslation(0, -0.03, 0).setMass(m)],
      // chest
      (m) => [C.roundCuboid(d.torsoW * 0.42, 0.18, d.torsoD * 0.4, 0.05).setTranslation(0, 0.08, 0).setMass(m)],
      // head
      (m) => [C.ball(d.headR * 0.98).setTranslation(0, d.headCY, 0).setMass(m)],
      // upper arm L
      (m) => [C.capsule(d.upperArm * 0.36, 0.07).setTranslation(0, -d.upperArm / 2, 0).setMass(m)],
      // fore arm L (+ fist)
      (m) => [
        C.capsule(d.foreArm * 0.34, 0.06).setTranslation(0, -d.foreArm / 2, 0).setMass(m * 0.6),
        C.ball(0.09).setTranslation(0, -d.foreArm - 0.07, 0).setMass(m * 0.4),
      ],
      (m) => [C.capsule(d.upperArm * 0.36, 0.07).setTranslation(0, -d.upperArm / 2, 0).setMass(m)],
      (m) => [
        C.capsule(d.foreArm * 0.34, 0.06).setTranslation(0, -d.foreArm / 2, 0).setMass(m * 0.6),
        C.ball(0.09).setTranslation(0, -d.foreArm - 0.07, 0).setMass(m * 0.4),
      ],
      // thigh L
      (m) => [C.capsule(d.thigh * 0.36, 0.09).setTranslation(0, -d.thigh / 2, 0).setMass(m)],
      // shin L (+ foot)
      (m) => [
        C.capsule(d.shin * 0.36, 0.075).setTranslation(0, -d.shin / 2, 0).setMass(m * 0.75),
        C.cuboid(0.065, 0.045, 0.13).setTranslation(0, -d.shin - d.ankle + 0.05, -0.06).setMass(m * 0.25),
      ],
      (m) => [C.capsule(d.thigh * 0.36, 0.09).setTranslation(0, -d.thigh / 2, 0).setMass(m)],
      (m) => [
        C.capsule(d.shin * 0.36, 0.075).setTranslation(0, -d.shin / 2, 0).setMass(m * 0.75),
        C.cuboid(0.065, 0.045, 0.13).setTranslation(0, -d.shin - d.ankle + 0.05, -0.06).setMass(m * 0.25),
      ],
    ];

    RAGDOLL_PARTS.forEach((def, i) => {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setLinearDamping(0.05)
          .setAngularDamping(1.2)
          .setCcdEnabled(i <= 2)
          .setEnabled(false)
          .setCanSleep(true),
      );
      const colliders: RAPIER.Collider[] = [];
      for (const desc of shapes[i](def.mass * massScale)) {
        desc
          .setCollisionGroups(cg)
          .setFriction(0.85)
          .setRestitution(0.12)
          .setActiveEvents(i <= 2 ? RAPIER.ActiveEvents.COLLISION_EVENTS : RAPIER.ActiveEvents.NONE);
        const c = world.createCollider(desc, body);
        physics.register(c, { kind: 'ragdoll', ref: owner, part: i, material: 'flesh' });
        colliders.push(c);
      }
      this.parts.push({
        body,
        colliders,
        prevP: new THREE.Vector3(),
        prevQ: new THREE.Quaternion(),
        curP: new THREE.Vector3(),
        curQ: new THREE.Quaternion(),
        prevVel: new THREE.Vector3(),
        hist: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
        histIdx: 0,
      });
    });

    // joints
    RAGDOLL_PARTS.forEach((def, i) => {
      if (def.parent < 0) return;
      const parentBone = RAGDOLL_PARTS[def.parent as number].bone;
      // anchor = child bone pivot expressed in parent bone space = accumulated bind offsets
      const anchor = this.offsetFrom(parentBone, def.bone);
      const isElbow = def.bone === B.foreArmL || def.bone === B.foreArmR;
      const isKnee = def.bone === B.shinL || def.bone === B.shinR;
      let data: RAPIER.JointData;
      if (isElbow || isKnee) {
        data = RAPIER.JointData.revolute(anchor, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
      } else {
        data = RAPIER.JointData.spherical(anchor, { x: 0, y: 0, z: 0 });
      }
      const j = world.createImpulseJoint(data, this.parts[def.parent].body, this.parts[i].body, true);
      j.setContactsEnabled(false);
      if (isElbow) (j as RAPIER.RevoluteImpulseJoint).setLimits(0, 2.5);
      if (isKnee) (j as RAPIER.RevoluteImpulseJoint).setLimits(-2.5, 0);
      this.joints.push(j);
    });
    this.setMuscle(0.2);
  }

  /** Bind-space offset of bone `child` relative to ancestor bone `ancestor`. */
  private offsetFrom(ancestor: number, child: number) {
    const v = new THREE.Vector3();
    let b: THREE.Object3D | null = this.rig.bones[child];
    while (b && b !== this.rig.bones[ancestor]) {
      v.add(this.rig.bindPos[this.rig.bones.indexOf(b as THREE.Bone)]);
      b = b.parent;
    }
    return { x: v.x, y: v.y, z: v.z };
  }

  /**
   * Muscle tone 0..1. Motors pull every joint toward the bind pose; stiffness
   * scales with tone so a KO'd body is floppy and a stunned one stays together.
   */
  setMuscle(tone: number) {
    if (Math.abs(tone - this.muscle) < 0.01) return;
    this.muscle = tone;
    const k = 4 + tone * 140;
    const c = 1.5 + tone * 14;
    this.joints.forEach((j, idx) => {
      const def = RAGDOLL_PARTS[idx + 1];
      const isElbow = def.bone === B.foreArmL || def.bone === B.foreArmR;
      const isKnee = def.bone === B.shinL || def.bone === B.shinR;
      if (isElbow || isKnee) {
        (j as RAPIER.RevoluteImpulseJoint).configureMotorPosition(isElbow ? 0.35 : -0.25, k * 0.5, c * 0.5);
      } else {
        const kk = def.bone === B.head ? k * 1.4 + 20 : def.bone === B.chest ? k * 1.6 + 10 : k;
        // Rapier reports spherical joints as "generic" in JS (no typed motor API) → use the raw per-axis motor
        const raw = (j as unknown as { rawSet: { jointConfigureMotorPosition: (h: number, axis: number, pos: number, k: number, c: number) => void } }).rawSet;
        for (const axis of [RAPIER.JointAxis.AngX, RAPIER.JointAxis.AngY, RAPIER.JointAxis.AngZ]) {
          raw.jointConfigureMotorPosition(j.handle, axis, 0, kk, c);
        }
      }
    });
  }

  /** Exclude collisions with a fighter capsule layer (e.g. while being carried by it). */
  setIgnoreFighter(fighterLayer: number | null) {
    const filter = fighterLayer ? this.baseFilter & ~fighterLayer : this.baseFilter;
    const cg = groups(this.membership, filter);
    for (const p of this.parts) for (const c of p.colliders) c.setCollisionGroups(cg);
  }

  /**
   * Switch on, matching the current rig pose. `baseVel` is added to the
   * per-bone velocity estimated from the animation.
   */
  activate(baseVel: THREE.Vector3, dt: number) {
    const rig = this.rig;
    rig.root.updateMatrixWorld(true);
    const invDt = dt > 1e-5 ? 1 / dt : 0;
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      const bone = rig.bones[RAGDOLL_PARTS[i].bone];
      bone.matrixWorld.decompose(_p, _q, _s);
      part.body.setBodyType(RAPIER.RigidBodyType.Dynamic, false);
      part.body.setTranslation(_p, false);
      part.body.setRotation(_q, false);
      // animated velocity (clamped) + base velocity
      const bi = RAGDOLL_PARTS[i].bone;
      _v.subVectors(rig.curPos[bi], rig.prevPos[bi]).multiplyScalar(invDt);
      if (_v.lengthSq() > 16) _v.setLength(4);
      _v.add(baseVel);
      part.body.setLinvel(_v, false);
      part.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      part.body.setEnabled(true);
      part.body.wakeUp();
      part.prevP.copy(_p);
      part.curP.copy(_p);
      part.prevQ.copy(_q);
      part.curQ.copy(_q);
      part.prevVel.copy(_v);
      for (const h of part.hist) h.copy(_v);
    }
    this.kinematic.clear();
    this.active = true;
  }

  deactivate() {
    for (const p of this.parts) {
      p.body.setEnabled(false);
      p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, false);
    }
    this.kinematic.clear();
    this.active = false;
    this.setIgnoreFighter(null);
  }

  setKinematic(partIdx: number, on: boolean) {
    const body = this.parts[partIdx].body;
    if (on && !this.kinematic.has(partIdx)) {
      body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.kinematic.add(partIdx);
    } else if (!on && this.kinematic.has(partIdx)) {
      body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      this.kinematic.delete(partIdx);
    }
  }

  releaseKinematic() {
    for (const i of [...this.kinematic]) this.setKinematic(i, false);
  }

  /** Drive a kinematic part to a world pose (applied on next physics step). */
  driveKinematic(partIdx: number, pos: THREE.Vector3, rot: THREE.Quaternion) {
    const b = this.parts[partIdx].body;
    b.setNextKinematicTranslation(pos);
    b.setNextKinematicRotation(rot);
  }

  setVelocity(v: THREE.Vector3, spin?: THREE.Vector3) {
    for (const p of this.parts) {
      p.body.setLinvel(v, true);
      if (spin) p.body.setAngvel(spin, true);
    }
  }

  addVelocity(v: THREE.Vector3) {
    for (const p of this.parts) {
      const lv = p.body.linvel();
      p.body.setLinvel({ x: lv.x + v.x, y: lv.y + v.y, z: lv.z + v.z }, true);
    }
  }

  applyImpulse(partIdx: number, impulse: THREE.Vector3, point?: THREE.Vector3) {
    const b = this.parts[partIdx].body;
    if (this.kinematic.has(partIdx)) return;
    if (point) b.applyImpulseAtPoint(impulse, point, true);
    else b.applyImpulse(impulse, true);
  }

  /** Called before each physics step: remember pre-step velocities. */
  preStep() {
    if (!this.active) return;
    for (const p of this.parts) {
      const v = p.body.linvel();
      p.prevVel.set(v.x, v.y, v.z);
      p.hist[p.histIdx].set(v.x, v.y, v.z);
      p.histIdx = (p.histIdx + 1) % p.hist.length;
    }
  }

  /** Called after each physics step: capture transforms for interpolation. */
  postStep() {
    if (!this.active) return;
    for (const p of this.parts) {
      p.prevP.copy(p.curP);
      p.prevQ.copy(p.curQ);
      const t = p.body.translation();
      const r = p.body.rotation();
      p.curP.set(t.x, t.y, t.z);
      p.curQ.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Highest recent velocity of a part (pre-impact estimate). */
  impactVel(part: number, out: THREE.Vector3) {
    let best = -1;
    for (const v of this.parts[part].hist) {
      const l = v.lengthSq();
      if (l > best) {
        best = l;
        out.copy(v);
      }
    }
    return out;
  }

  /** Pelvis position (current step). */
  pelvisPos(out: THREE.Vector3) {
    return out.copy(this.parts[0].curP);
  }

  speed() {
    const v = this.parts[0].body.linvel();
    const w = this.parts[1].body.linvel();
    return Math.max(Math.hypot(v.x, v.y, v.z), Math.hypot(w.x, w.y, w.z));
  }

  /**
   * Pose the rig bones from the ragdoll (interpolated by alpha).
   * Root bone goes to identity so pelvis world == pelvis local.
   */
  applyToRig(alpha: number) {
    const rig = this.rig;
    rig.root.position.set(0, 0, 0);
    rig.root.quaternion.identity();
    rig.root.updateMatrix();
    rig.root.matrixWorld.copy(rig.root.matrix);
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      const bone = rig.bones[RAGDOLL_PARTS[i].bone];
      _p.lerpVectors(part.prevP, part.curP, alpha);
      _q.slerpQuaternions(part.prevQ, part.curQ, alpha);
      _m.compose(_p, _q, _s.set(1, 1, 1));
      // local = parentWorld^-1 * world  (parents are processed first: table order is hierarchical)
      const parent = bone.parent as THREE.Object3D;
      _mi.copy(parent.matrixWorld).invert().multiply(_m);
      _mi.decompose(bone.position, bone.quaternion, _s);
      bone.scale.set(1, 1, 1);
      bone.matrix.compose(bone.position, bone.quaternion, bone.scale);
      bone.matrixWorld.copy(_m);
    }
    // keep hands/feet straight relative to their parents and refresh the rest of the hierarchy
    for (const b of [B.handL, B.handR, B.footL, B.footR]) {
      rig.bones[b].quaternion.identity();
      rig.bones[b].scale.set(1, 1, 1);
    }
    rig.root.updateMatrixWorld(true);
  }

  /** Average facing (yaw) of the torso, used when getting back up. */
  torsoYaw() {
    const q = this.parts[RP.chest].curQ;
    _v.set(0, 0, -1).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    // lying face down: torso forward points down; use torso up projected instead
    if (Math.abs(_v.y) > 0.7) _v.copy(up).multiplyScalar(-Math.sign(_v.y));
    return Math.atan2(-_v.x, -_v.z);
  }

  /** Is the body lying face up? */
  faceUp() {
    _v.set(0, 0, -1).applyQuaternion(this.parts[RP.chest].curQ);
    return _v.y > 0;
  }
}
