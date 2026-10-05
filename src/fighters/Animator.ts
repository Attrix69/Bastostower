import * as THREE from 'three';
import { clamp, clamp01, dampFactor, forwardFromYaw, rightFromYaw, smoothstep, Spring3, TAU } from '../core/math';
import { FOOT_REST, GUARD_L, GUARD_R, HEAVY_THRESHOLD, samplePath } from './attacks';
import type { Fighter } from './Fighter';
import { solveTwoBone } from './IK';
import { B } from './Rig';
import { FState } from './states';
import type { Zone } from '../game/events';

/**
 * Procedural animation: no clips, everything is computed from the fighter's
 * physical state every step. Layers (bottom → top):
 *  1. locomotion FK (walk/run/strafe cycle, boxer bounce, air tuck)
 *  2. spine/head aim + spring-based hit reactions (organic overshoot)
 *  3. arm IK driven by attack trajectories / guard / block / holds
 *  4. kick leg IK
 *  5. state overlays (stun wobble, edge windmill, victory dance)
 *  6. face (pupils, blinks, mouth, brows, KO eyes)
 *  7. get-up blend from the captured ragdoll pose
 */

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _t = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _mi = new THREE.Matrix4();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const STRIDE = 1.55;

function setRot(bone: THREE.Bone, x: number, y: number, z: number, order: THREE.EulerOrder = 'XYZ') {
  _e.set(x, y, z, order);
  bone.quaternion.setFromEuler(_e);
}

export class Animator {
  phase = 0;
  rootOffsetY = 0;
  rootYawOffset = 0;
  private time = Math.random() * 10;
  private chestSpring = new Spring3(165, 12);
  private headSpring = new Spring3(200, 10);
  private stagger = new Spring3(110, 13);
  private curL = new THREE.Vector3(...GUARD_L);
  private curR = new THREE.Vector3(...GUARD_R);
  private sprintW = 0;
  private airW = 0;
  private blockW = 0;
  private stunW = 0;
  private teeterW = 0;
  private kickW = 0;
  private idleW = 1;
  private blinkT = 0;
  private nextBlink = 2;
  private mouth = 0.2;
  private hurtT = 0;
  private getUp: { quats: THREE.Quaternion[]; pelvisPos: THREE.Vector3 } | null = null;
  victory = false;
  private lastSpeed = 0;

  constructor(private f: Fighter) {}

  reset() {
    this.chestSpring.reset();
    this.headSpring.reset();
    this.stagger.reset();
    this.curL.set(...GUARD_L);
    this.curR.set(...GUARD_R);
    this.getUp = null;
    this.victory = false;
    this.kickW = 0;
    this.sprintW = this.airW = this.blockW = this.stunW = this.teeterW = 0;
  }

  /** Called right after the ragdoll pose was applied to the rig, before control returns to animation. */
  captureForGetUp(pos: THREE.Vector3, yaw: number) {
    const rig = this.f.rig;
    const quats: THREE.Quaternion[] = [];
    for (let i = 0; i < 16; i++) quats.push(rig.bones[i].quaternion.clone());
    // pelvis world → local relative to the new root
    const pelvis = rig.bones[B.pelvis];
    _m.compose(pos, _q.setFromAxisAngle(UP, yaw), _s.set(1, 1, 1));
    _mi.copy(_m).invert().multiply(pelvis.matrixWorld);
    const pp = new THREE.Vector3();
    const pq = new THREE.Quaternion();
    _mi.decompose(pp, pq, _s);
    quats[B.pelvis].copy(pq);
    this.getUp = { quats, pelvisPos: pp };
    this.chestSpring.reset();
    this.headSpring.reset();
  }

  hitReact(dir: THREE.Vector3, zone: Zone, power: number, heavy: boolean) {
    const f = this.f;
    // world dir → body local (forward = -Z)
    const c = Math.cos(-f.yaw);
    const s = Math.sin(-f.yaw);
    const lx = dir.x * c - dir.z * s;
    const lz = dir.x * s + dir.z * c;
    const m = (heavy ? 7 : 4.5) * clamp(power, 0.3, 1.8);
    // rotate the top of the body along the hit direction
    this.chestSpring.impulse(lz * m * 0.8, -lx * m * 0.3, -lx * m * 0.8);
    const hm = zone === 'head' ? 2.2 : 1.1;
    this.headSpring.impulse(lz * m * hm, -lx * m * 0.9 * hm, -lx * m * hm);
    this.stagger.impulse(lx * power * 1.6, 0, lz * power * 1.6);
    this.hurtT = 0.45;
    this.mouth = 1.2;
  }

  /** world → aim space of this fighter */
  private worldToAim(p: THREE.Vector3, out: THREE.Vector3) {
    const f = this.f;
    f.aimQuat(_q).invert();
    return out.copy(p).sub(f.eye(_v2)).applyQuaternion(_q);
  }

  update(dt: number) {
    const f = this.f;
    const rig = f.rig;
    const d = rig.dims;
    const bones = rig.bones;
    this.time += dt;
    const t = this.time;
    const k = (l: number) => dampFactor(l, dt);
    rig.resetPose();

    // ------------------------------------------------ locomotion state
    const invDt = dt > 1e-5 ? 1 / dt : 0;
    let vx = (f.pos.x - f.prevPos.x) * invDt;
    let vz = (f.pos.z - f.prevPos.z) * invDt;
    if (!isFinite(vx) || !isFinite(vz) || dt <= 1e-5) {
      vx = 0;
      vz = 0;
    }
    let speed = Math.hypot(vx, vz);
    if (speed > 14) speed = 14;
    this.lastSpeed += (speed - this.lastSpeed) * k(12);
    speed = this.lastSpeed;
    forwardFromYaw(f.yaw, _fwd);
    rightFromYaw(f.yaw, _right);
    const vf = speed > 0.15 ? (vx * _fwd.x + vz * _fwd.z) / Math.max(speed, 0.001) : 1;
    const vr = speed > 0.15 ? (vx * _right.x + vz * _right.z) / Math.max(speed, 0.001) : 0;
    const dirSign = vf < -0.3 ? -1 : 1;
    this.phase = (this.phase + (speed * dt * dirSign) / STRIDE + 1) % 1;
    const move = clamp(speed / 4.5, 0, 1.4);
    const state = f.state;
    const stunned = state === FState.Stunned;
    const gettingUp = state === FState.GettingUp && this.getUp;
    this.sprintW += ((speed > 5.6 && !f.action && !f.hold && !f.blocking ? 1 : 0) - this.sprintW) * k(8);
    this.airW += ((f.grounded ? 0 : 1) - this.airW) * k(10);
    this.blockW += ((f.blocking ? 1 : 0) - this.blockW) * k(22);
    this.stunW += ((stunned ? 1 : 0) - this.stunW) * k(6);
    this.teeterW += ((f.teeter > 0.3 && !f.action ? 1 : 0) - this.teeterW) * k(10);
    this.idleW += ((move < 0.15 ? 1 : 0) - this.idleW) * k(6);
    const kicking = f.action && f.action.def.limb === 'footR';
    this.kickW += ((kicking ? 1 : 0) - this.kickW) * k(kicking ? 30 : 12);

    // ------------------------------------------------ legs FK
    const ph = this.phase * TAU;
    for (const side of [-1, 1] as const) {
      const thigh = bones[side < 0 ? B.thighL : B.thighR];
      const shin = bones[side < 0 ? B.shinL : B.shinR];
      const foot = bones[side < 0 ? B.footL : B.footR];
      const p = ph + (side > 0 ? Math.PI : 0);
      const amp = Math.min(move, 1.25);
      const swing = Math.sin(p) * 0.6 * amp;
      const lift = Math.max(0, Math.cos(p)) * 1.0 * amp;
      let tx = swing * vf;
      let tz = swing * vr * 0.55;
      let knee = -(lift * (0.6 + 0.4 * Math.abs(vf)) + 0.1);
      // idle boxer stance
      const stance = side < 0 ? 0.16 : -0.12;
      const bounce = Math.sin(t * TAU * 1.6) * 0.04;
      tx += this.idleW * stance;
      tz += this.idleW * side * 0.06;
      knee += this.idleW * (-0.32 + bounce);
      // airborne tuck
      tx += this.airW * (side < 0 ? 0.7 : 0.35);
      knee += this.airW * (side < 0 ? -1.2 : -0.6);
      // stun wobble
      if (this.stunW > 0.01) {
        knee += this.stunW * (-0.3 + Math.sin(t * 5.3 + side) * 0.2);
        tz += this.stunW * Math.sin(t * 2.2) * 0.12;
      }
      // teeter: one leg kicks up
      if (this.teeterW > 0.01 && side > 0) {
        tx += this.teeterW * (0.5 + Math.sin(t * 9) * 0.3);
        knee -= this.teeterW * 0.6;
      }
      setRot(thigh, tx, 0, tz);
      setRot(shin, knee, 0, 0);
      setRot(foot, -(tx + knee) * 0.7, 0, 0);
    }

    // ------------------------------------------------ pelvis
    const pelvis = bones[B.pelvis];
    const bob = -Math.abs(Math.sin(ph)) * 0.055 * Math.min(move, 1.2);
    const idleCrouch = this.idleW * (0.045 - Math.sin(t * TAU * 1.6) * 0.012);
    this.stagger.update(dt);
    pelvis.position.set(this.stagger.value.x * 0.25, d.pelvisY + bob - idleCrouch - this.airW * 0.05, this.stagger.value.z * 0.25);
    let pelvisYaw = Math.sin(ph) * 0.13 * Math.min(move, 1);
    let pelvisRoll = Math.sin(ph) * 0.05 * Math.min(move, 1);
    if (this.stunW > 0.01) {
      pelvis.position.y -= this.stunW * 0.06;
      pelvisRoll += this.stunW * Math.sin(t * 1.7) * 0.1;
    }
    // kick: hips pushed forward, lower
    if (this.kickW > 0.01) {
      pelvis.position.z -= this.kickW * 0.14;
      pelvisYaw -= this.kickW * 0.25;
    }
    setRot(pelvis, 0, pelvisYaw, pelvisRoll);

    // ------------------------------------------------ chest / head
    const chest = bones[B.chest];
    const head = bones[B.head];
    this.chestSpring.update(dt);
    this.headSpring.update(dt);
    let cx = -0.08 * move - this.sprintW * 0.22 + f.pitch * 0.28;
    let cy = -pelvisYaw * 0.8;
    let cz = -pelvisRoll * 0.6;
    const a = f.action;
    if (a && a.def.frame === 'aim') {
      // twist into the punch
      const isL = a.def.limb === 'handL';
      const holdK = a.phase === 'hold' ? clamp01(a.holdTime / 0.2) : 0;
      const strikeK = a.phase === 'strike' ? Math.sin(clamp01(a.t / (a.def.active[1] + 0.05)) * Math.PI) : 0;
      const twist = isL ? -1 : 1;
      cy += twist * (-0.32 * holdK + 0.45 * strikeK);
      cx -= 0.12 * strikeK;
    }
    if (this.kickW > 0.01) cx += this.kickW * 0.32;
    if (this.stunW > 0.01) {
      cx += this.stunW * Math.sin(t * 1.9) * 0.14;
      cz += this.stunW * Math.sin(t * 1.35) * 0.2;
    }
    if (this.teeterW > 0.01) {
      cx += this.teeterW * (0.32 + Math.sin(t * 7) * 0.1);
      cz += this.teeterW * Math.sin(t * 5) * 0.15;
    }
    if (f.hold?.kind === 'fighter' && f.hold.mode === 'carry') cx += 0.12 + Math.sin(t * 3) * 0.03;
    if (this.blockW > 0.01) cx -= this.blockW * 0.12;
    setRot(chest, cx + this.chestSpring.value.x, cy + this.chestSpring.value.y, cz + this.chestSpring.value.z);
    let hx = f.pitch * 0.55 - cx * 0.5;
    let hz = -cz * 0.4;
    let hy = -cy * 0.6;
    if (this.stunW > 0.01) {
      hz += this.stunW * Math.sin(t * 2.6) * 0.32;
      hx += this.stunW * (Math.sin(t * 1.7) * 0.2 - 0.1);
    }
    if (this.victory) {
      hx += 0.3;
    }
    setRot(head, hx + this.headSpring.value.x, hy + this.headSpring.value.y, hz + this.headSpring.value.z);

    // ------------------------------------------------ root
    const root = rig.root;
    let rootY = 0;
    if (this.victory) rootY = Math.abs(Math.sin(t * 6)) * 0.18;
    this.rootOffsetY = rootY;
    this.rootYawOffset = 0;
    root.position.set(f.pos.x, f.pos.y + rootY, f.pos.z);
    root.quaternion.setFromAxisAngle(UP, f.yaw);
    root.updateMatrixWorld(true);

    // ------------------------------------------------ arms
    this.updateArms(dt, t);

    // ------------------------------------------------ kick leg IK
    if (this.kickW > 0.01 && a && a.def.limb === 'footR') {
      const pathT = a.phase === 'hold' ? 0 : a.t;
      samplePath(a.def.path, pathT, _t);
      if (a.phase === 'hold') {
        _t.lerpVectors(_v.set(...FOOT_REST), _t, clamp01(a.holdTime / 0.08));
        if (a.heavyReady) _t.x += (Math.random() - 0.5) * 0.01;
      }
      f.framePoint('body', _t, _v);
      const hip = bones[B.thighR];
      _pole.setFromMatrixPosition(hip.matrixWorld).addScaledVector(_fwd, 1).addScaledVector(UP, 0.4);
      root.updateMatrixWorld(true);
      solveTwoBone(hip, bones[B.shinR], bones[B.footR], _v, _pole, d.thigh, d.shin, true, 1.3, this.kickW);
      setRot(bones[B.footR], -0.6 * this.kickW, 0, 0);
    }

    // ------------------------------------------------ get-up blend
    if (gettingUp && this.getUp) {
      const w = smoothstep(0, 1, clamp01(f.stateTime / f.getUpDuration));
      const g = this.getUp;
      // crouch mid-way
      pelvis.position.y -= (1 - w) * 0.35;
      for (let i = 1; i < 16; i++) bones[i].quaternion.slerpQuaternions(g.quats[i], bones[i].quaternion, w);
      pelvis.position.lerpVectors(g.pelvisPos, pelvis.position, w);
      for (let i = 1; i < 16; i++) bones[i].scale.set(1, 1, 1);
    } else if (state !== FState.GettingUp) {
      this.getUp = null;
    }

    // ------------------------------------------------ stars, face
    rig.stars.visible = stunned || (f.koTimer > 0 && f.isDown);
    if (rig.stars.visible) this.spinStars(t);
    this.updateFace(dt);
    root.updateMatrixWorld(true);
  }

  private spinStars(t: number) {
    const stars = this.f.rig.stars;
    stars.children.forEach((s, i) => {
      const a = t * 4 + (i / stars.children.length) * TAU;
      s.position.set(Math.cos(a) * 0.22, Math.sin(t * 6 + i) * 0.03, Math.sin(a) * 0.22);
      s.rotation.set(0, -a, t * 3);
    });
  }

  private updateArms(dt: number, t: number) {
    const f = this.f;
    const rig = f.rig;
    const d = rig.dims;
    const bones = rig.bones;
    const a = f.action;
    const k = (l: number) => dampFactor(l, dt);
    const desL = _v.set(...GUARD_L);
    const desR = _v2.set(...GUARD_R);
    // breathing / bounce on the guard
    const br = Math.sin(t * TAU * 1.6) * 0.012;
    desL.y += br;
    desR.y += br * 0.8;
    let exactL = false;
    let exactR = false;
    let ikL = true;
    let ikR = true;

    if (this.blockW > 0.5) {
      desL.set(-0.1, -0.04, -0.26);
      desR.set(0.11, -0.06, -0.26);
    }
    const h = f.hold;
    if (h?.kind === 'prop') {
      if (h.twoHanded) {
        if (a && a.button === 'throw') {
          const y = a.phase === 'hold' ? 0.15 : -0.05;
          const z = a.phase === 'hold' ? -0.42 : -0.8;
          desL.set(-0.2, y, z);
          desR.set(0.2, y, z);
        } else {
          desL.set(-0.2, -0.3, -0.55);
          desR.set(0.2, -0.3, -0.55);
        }
      } else {
        desR.set(0.24, -0.27, -0.42);
      }
    } else if (h?.kind === 'fighter') {
      const victim = h.target;
      if (h.mode === 'carry') {
        _fwd.set(0, 0, 0);
        desL.set(-0.3, 0.3 + Math.sin(t * 3) * 0.02, -0.12);
        desR.set(0.3, 0.3 + Math.cos(t * 3) * 0.02, -0.12);
        exactL = exactR = true;
      } else {
        // collar grab: right hand on the victim's chest
        _t.set(0, 0.22, 0).applyMatrix4(victim.rig.bones[B.chest].matrixWorld);
        this.worldToAim(_t, desR);
        exactR = true;
      }
    }

    if (a) {
      const pathT = a.phase === 'hold' ? 0 : a.t;
      if (a.def.limb === 'handL' || a.def.limb === 'handR' || a.def.limb === 'weapon') {
        samplePath(a.def.path, pathT, _t);
        if (a.phase === 'hold' && a.holdTime > HEAVY_THRESHOLD) {
          // charging tremble
          _t.x += (Math.random() - 0.5) * 0.012;
          _t.y += (Math.random() - 0.5) * 0.012;
        }
        const left = a.def.limb === 'handL';
        if (h?.kind === 'fighter' && h.mode === 'carry' && a.button === 'throw') {
          // heave the body forward with both hands
          const fwdK = a.phase === 'hold' ? -0.05 : Math.min(1, a.t / 0.1);
          desL.set(-0.3, 0.3 - fwdK * 0.25, -0.12 - fwdK * 0.5);
          desR.set(0.3, 0.3 - fwdK * 0.25, -0.12 - fwdK * 0.5);
        } else if (h?.kind === 'prop' && h.twoHanded) {
          // handled above
        } else if (left) {
          desL.copy(_t);
          exactL = a.phase === 'strike';
        } else {
          desR.copy(_t);
          exactR = a.phase === 'strike';
        }
      }
    }

    // stunned arms dangle (FK), teeter windmill (FK), sprint pump (FK blend)
    const fkStun = this.stunW > 0.5 && !a;
    const fkTeeter = this.teeterW > 0.4 && !a && !h;
    if (fkStun || fkTeeter) {
      ikL = ikR = false;
    }
    if (exactL) this.curL.copy(desL);
    else this.curL.lerp(desL, k(a ? 26 : 16));
    if (exactR) this.curR.copy(desR);
    else this.curR.lerp(desR, k(a ? 26 : 16));

    const sides: [THREE.Bone, THREE.Bone, THREE.Bone, THREE.Vector3, number, boolean][] = [
      [bones[B.upperArmL], bones[B.foreArmL], bones[B.handL], this.curL, -1, ikL],
      [bones[B.upperArmR], bones[B.foreArmR], bones[B.handR], this.curR, 1, ikR],
    ];
    for (const [upper, fore, hand, cur, side, ik] of sides) {
      if (ik) {
        f.framePoint('aim', cur, _t);
        _pole.setFromMatrixPosition(upper.matrixWorld);
        _pole.addScaledVector(_right, side * 0.55).addScaledVector(UP, -0.75).addScaledVector(_fwd, -0.25);
        solveTwoBone(upper, fore, hand, _t, _pole, d.upperArm, d.foreArm + 0.075, false, 1.32);
        // sprinting: blend toward pumping arms
        if (this.sprintW > 0.05 && !a && !h) {
          const sw = Math.sin(this.phase * TAU + (side > 0 ? 0 : Math.PI)) * 0.9;
          _e.set(sw, 0, side * 0.12, 'XYZ');
          _q.setFromEuler(_e);
          upper.quaternion.slerp(_q, this.sprintW);
          _q.setFromAxisAngle(_v.set(1, 0, 0), 1.5);
          fore.quaternion.slerp(_q, this.sprintW);
          upper.scale.set(1, 1, 1);
          hand.scale.set(1, 1, 1);
        }
      } else if (fkTeeter) {
        const spin = t * 13 + (side > 0 ? Math.PI : 0);
        setRot(upper, spin, 0, side * 0.55, 'ZXY');
        setRot(fore, 0.4, 0, 0);
      } else {
        // dangling stunned arms
        setRot(upper, Math.sin(t * 2.1 + side) * 0.3, 0, side * (0.18 + Math.sin(t * 1.6) * 0.08));
        setRot(fore, 0.25 + Math.sin(t * 3 + side) * 0.15, 0, 0);
      }
    }

    if (this.victory) {
      // victory: fists pumping in the air
      for (const [upper, fore, , , side] of sides) {
        setRot(upper, Math.PI * 0.95 + Math.sin(t * 6 + (side > 0 ? 0 : Math.PI)) * 0.25, 0, side * 0.25);
        setRot(fore, 0.4 + Math.sin(t * 6) * 0.3, 0, 0);
        upper.scale.set(1, 1, 1);
      }
    }
  }

  /** Face animation — also used while ragdolled. */
  updateFace(dt: number) {
    const f = this.f;
    const rig = f.rig;
    const bones = rig.bones;
    const d = rig.dims;
    const t = this.time;
    const ko = f.koTimer > 0 && f.isDown;
    const falling = f.state === FState.Falling;
    const stunned = f.state === FState.Stunned;
    this.hurtT = Math.max(0, this.hurtT - dt);

    // pupils
    const pupilL = bones[B.pupilL];
    const pupilR = bones[B.pupilR];
    let ox = 0;
    let oy = 0;
    if (stunned || (f.state === FState.Thrown && !ko)) {
      ox = Math.cos(t * 9) * 0.022;
      oy = Math.sin(t * 9) * 0.018;
    } else if (f.opponent) {
      const head = bones[B.head];
      _t.copy(f.opponent.rig.curPos[B.head]);
      _t.y += 0.2;
      _mi.copy(head.matrixWorld).invert();
      _t.applyMatrix4(_mi).normalize();
      ox = clamp(_t.x * 0.06, -0.022, 0.022);
      oy = clamp(_t.y * 0.06, -0.016, 0.018);
    }
    const bpL = rig.bindPos[B.pupilL];
    const bpR = rig.bindPos[B.pupilR];
    pupilL.position.set(bpL.x + ox, bpL.y + oy, bpL.z);
    pupilR.position.set(bpR.x + (stunned ? -ox : ox), bpR.y + (stunned ? -oy : oy), bpR.z);
    const ps = ko ? 0 : falling ? 1.25 : 1;
    pupilL.scale.setScalar(ps);
    pupilR.scale.setScalar(ps);
    bones[B.koEyes].scale.setScalar(ko ? 1 : 0.0001);

    // blink
    this.blinkT -= dt;
    if (this.blinkT <= -this.nextBlink) {
      this.blinkT = 0.12;
      this.nextBlink = 1.5 + Math.random() * 3.5;
    }
    let lid = this.blinkT > 0 ? 1 : 0.02;
    if (this.hurtT > 0) lid = Math.max(lid, 0.55);
    if (ko || falling) lid = 0.02;
    bones[B.lidL].scale.set(1, lid, 1);
    bones[B.lidR].scale.set(1, lid, 1);

    // mouth
    let target = 0.2;
    if (f.action?.phase === 'strike' && f.action.t < 0.2) target = 0.85;
    if (f.action?.phase === 'hold' && f.action.holdTime > HEAVY_THRESHOLD) target = 0.45;
    if (stunned) target = 0.5 + Math.sin(t * 7) * 0.25;
    if (ko) target = 0.75;
    if (falling) target = 1.35 + Math.sin(t * 20) * 0.1;
    if (f.hold?.kind === 'fighter') target = 0.55;
    if (f.state === FState.Carried || f.state === FState.Grabbed) target = ko ? 0.75 : 0.9 + Math.sin(t * 14) * 0.2;
    if (this.victory) target = 1 + Math.sin(t * 12) * 0.2;
    this.mouth += (target - this.mouth) * dampFactor(14, dt);
    if (this.hurtT > 0.2) this.mouth = Math.max(this.mouth, 1.0);
    bones[B.mouth].scale.set(1 + this.mouth * 0.15, 0.25 + this.mouth * 0.9, 1);

    // brows: angry by default, raised when hurt/surprised
    const surprised = this.hurtT > 0 || falling || stunned || ko || f.state === FState.Carried;
    const ang = surprised ? -0.28 : 0.3;
    const lift = surprised ? 0.025 : 0;
    const bl = rig.bindPos[B.browL];
    const brr = rig.bindPos[B.browR];
    bones[B.browL].position.set(bl.x, bl.y + lift, bl.z);
    bones[B.browR].position.set(brr.x, brr.y + lift, brr.z);
    setRot(bones[B.browL], 0, 0, -ang);
    setRot(bones[B.browR], 0, 0, ang);
    void d;
  }
}
