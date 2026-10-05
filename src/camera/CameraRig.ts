import * as THREE from 'three';
import { clamp, dampFactor, noise1, Spring, smoothstep } from '../core/math';
import type { Fighter } from '../fighters/Fighter';
import type { Physics } from '../physics/Physics';
import { G, groups } from '../physics/Physics';
import { FState } from '../fighters/states';

/**
 * First-person camera with game-feel layers:
 *  - head bob tied to the stride, landing dip, strafe tilt
 *  - trauma-based shake (squared, smooth noise) + rotational kick springs
 *  - dynamic FOV (sprint, charge zoom, impact punch-in)
 * plus third-person / cinematic modes (knocked out, carried, falling, menu)
 * with smooth blends between modes.
 */

export type CamMode = 'fps' | 'orbit' | 'finish' | 'menu' | 'winner';

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _m = new THREE.Matrix4();
const _dir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  mode: CamMode = 'menu';
  baseFov = 80;
  trauma = 0;
  readonly kickPitch = new Spring(260, 16);
  readonly kickYaw = new Spring(260, 16);
  readonly kickRoll = new Spring(200, 12);
  readonly fovKick = new Spring(120, 11);
  private dip = new Spring(160, 13);
  private bobPhase = 0;
  private bobAmp = 0;
  private tilt = 0;
  private time = 0;
  private blendT = 1;
  private blendDur = 0.5;
  private fromPos = new THREE.Vector3();
  private fromQuat = new THREE.Quaternion();
  private fromFov = 80;
  private fov = 80;
  /** finish-cam data */
  private finishTarget: Fighter | null = null;
  private finishOther: Fighter | null = null;
  private finishAnchor = new THREE.Vector3();
  private finishT = 0;
  private orbitDist = 3.4;
  private winner: Fighter | null = null;
  private lastPlayerPos = new THREE.Vector3();
  /** last computed eye for other systems (view model) */
  readonly eye = new THREE.Vector3();
  /** current bob offset in camera space for the view model */
  readonly bob = new THREE.Vector3();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private physics: Physics,
  ) {}

  setMode(mode: CamMode, blend = 0.5) {
    if (mode === this.mode) return;
    this.fromPos.copy(this.camera.position);
    this.fromQuat.copy(this.camera.quaternion);
    this.fromFov = this.camera.fov;
    this.mode = mode;
    this.blendT = blend > 0 ? 0 : 1;
    this.blendDur = Math.max(blend, 0.001);
  }

  startFinish(falling: Fighter, other: Fighter) {
    this.finishTarget = falling;
    this.finishOther = other;
    this.finishT = 0;
    // anchor: the roof point where the body went over, slightly inside & up
    falling.ragdoll.pelvisPos(_p);
    const dx = -_p.x;
    const dz = -_p.z;
    const l = Math.hypot(dx, dz) || 1;
    this.finishAnchor.set(_p.x + (dx / l) * 2.2, 2.6, _p.z + (dz / l) * 2.2);
    this.setMode('finish', 0.35);
  }

  showWinner(f: Fighter) {
    this.winner = f;
    this.setMode('winner', 0.9);
  }

  addTrauma(k: number) {
    this.trauma = Math.min(1, this.trauma + k);
  }

  /** Recoil when the player lands a hit or gets hit. */
  kick(pitch: number, yaw: number, roll: number, fov = 0) {
    this.kickPitch.impulse(pitch * 60);
    this.kickYaw.impulse(yaw * 60);
    this.kickRoll.impulse(roll * 60);
    if (fov) this.fovKick.impulse(fov * 40);
  }

  update(realDt: number, dt: number, alpha: number, player: Fighter, yaw: number, pitch: number) {
    this.time += realDt;
    const cam = this.camera;
    for (const s of [this.kickPitch, this.kickYaw, this.kickRoll, this.fovKick, this.dip]) s.update(Math.min(realDt, 0.05));
    this.trauma = Math.max(0, this.trauma - realDt * 1.5);

    // target pose for the current mode
    let fov = this.baseFov;
    switch (this.mode) {
      case 'fps':
        this.fpsPose(dt, alpha, player, yaw, pitch);
        fov = this.fpsFov(player);
        break;
      case 'orbit':
        this.orbitPose(player, yaw, pitch, realDt);
        fov = this.baseFov - 4;
        break;
      case 'finish':
        fov = this.finishPose(realDt);
        break;
      case 'winner':
        this.winnerPose();
        fov = 55;
        break;
      case 'menu':
        this.menuPose();
        fov = 55;
        break;
    }

    // shake (all modes) — squared trauma, smooth noise
    const sh = this.trauma * this.trauma;
    if (sh > 0.0001) {
      const t = this.time * 22;
      _e.set(noise1(t, 1) * 0.07 * sh, noise1(t, 2) * 0.07 * sh, noise1(t, 3) * 0.09 * sh, 'YXZ');
      _q.setFromEuler(_e);
      cam.quaternion.multiply(_q);
      cam.position.x += noise1(t, 4) * 0.04 * sh;
      cam.position.y += noise1(t, 5) * 0.04 * sh;
    }

    // blend from previous mode
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + realDt / this.blendDur);
      const k = smoothstep(0, 1, this.blendT);
      cam.position.lerpVectors(this.fromPos, cam.position, k);
      cam.quaternion.slerpQuaternions(this.fromQuat, cam.quaternion, k);
      fov = this.fromFov + (fov - this.fromFov) * k;
    }
    this.fov += (fov - this.fov) * dampFactor(10, realDt);
    const f = this.fov + this.fovKick.value;
    if (Math.abs(cam.fov - f) > 0.01) {
      cam.fov = f;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
  }

  private fpsPose(dt: number, alpha: number, p: Fighter, yaw: number, pitch: number) {
    const cam = this.camera;
    _p.lerpVectors(p.prevPos, p.pos, alpha);
    // stride-locked bob
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const moving = p.grounded && speed > 0.5;
    this.bobAmp += ((moving ? Math.min(speed / 4.5, 1.4) : 0) - this.bobAmp) * dampFactor(8, Math.max(dt, 0.001));
    const moved = Math.hypot(_p.x - this.lastPlayerPos.x, _p.z - this.lastPlayerPos.z);
    if (moved < 1) this.bobPhase += (moved / 1.55) * Math.PI * 2;
    this.lastPlayerPos.copy(_p);
    const by = -Math.abs(Math.sin(this.bobPhase)) * 0.045 * this.bobAmp + 0.02 * this.bobAmp;
    const bx = Math.cos(this.bobPhase) * 0.022 * this.bobAmp;
    this.bob.set(bx, by, 0);
    // landing dip
    let dip = this.dip.value;
    if (p.state === FState.GettingUp) dip -= (1 - clamp(p.stateTime / p.getUpDuration, 0, 1)) * 0.8;
    const stunned = p.state === FState.Stunned;
    // strafe tilt + stun sway
    const strafe = p.intent.moveX;
    this.tilt += (-strafe * 0.022 - this.tilt) * dampFactor(8, Math.max(dt, 0.001));
    let roll = this.tilt + this.kickRoll.value;
    let yawOff = this.kickYaw.value;
    let pitchOff = this.kickPitch.value;
    if (stunned) {
      roll += Math.sin(this.time * 1.6) * 0.09;
      yawOff += Math.sin(this.time * 0.9) * 0.05;
      pitchOff += Math.sin(this.time * 1.2) * 0.04;
    }
    if (p.teeter > 0.2) {
      roll += Math.sin(this.time * 9) * 0.04 * p.teeter;
      pitchOff -= 0.12 * p.teeter;
    }
    _e.set(pitch + pitchOff, yaw + yawOff, roll, 'YXZ');
    cam.quaternion.setFromEuler(_e);
    // eye position
    cam.position.set(_p.x, _p.y + p.eyeHeight + dip, _p.z);
    _t.set(bx, by, 0).applyQuaternion(cam.quaternion);
    cam.position.add(_t);
    this.eye.copy(cam.position);
  }

  private fpsFov(p: Fighter) {
    let fov = this.baseFov;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    if (speed > 5.6) fov += 7;
    const a = p.action;
    if (a && a.phase === 'hold' && a.holdTime > 0.17) fov -= Math.min(6, (a.holdTime - 0.17) * 9);
    if (p.state === FState.Stunned) fov += Math.sin(this.time * 2) * 3;
    return fov;
  }

  private orbitPose(p: Fighter, yaw: number, pitch: number, realDt: number) {
    const cam = this.camera;
    p.ragdoll.active ? p.ragdoll.pelvisPos(_t) : _t.set(p.pos.x, p.pos.y + 1, p.pos.z);
    // when carried, frame both bodies
    if (p.heldBy) _t.lerp(_p.set(p.heldBy.pos.x, p.heldBy.pos.y + 1.6, p.heldBy.pos.z), 0.4);
    _t.y += 0.3;
    const pt = clamp(-pitch + 0.35, -0.2, 1.2);
    _dir.set(Math.sin(yaw) * Math.cos(pt), Math.sin(pt), Math.cos(yaw) * Math.cos(pt));
    // keep the camera out of walls
    let dist = 3.6;
    const hit = this.physics.raycast(_t, _dir, dist + 0.3, groups(G.ALL, G.STATIC));
    if (hit) dist = Math.max(0.6, hit.distance - 0.3);
    this.orbitDist += (dist - this.orbitDist) * dampFactor(dist < this.orbitDist ? 30 : 4, realDt);
    cam.position.copy(_t).addScaledVector(_dir, this.orbitDist);
    if (cam.position.y < _t.y - 0.5 && cam.position.y < 0.3 && Math.abs(cam.position.x) < 13 && Math.abs(cam.position.z) < 10) cam.position.y = 0.3;
    _m.lookAt(cam.position, _t, UP);
    cam.quaternion.setFromRotationMatrix(_m);
    _e.setFromQuaternion(cam.quaternion, 'YXZ');
    _e.z += this.kickRoll.value;
    cam.quaternion.setFromEuler(_e);
  }

  private finishPose(realDt: number): number {
    const cam = this.camera;
    const f = this.finishTarget;
    if (!f) return this.baseFov;
    this.finishT += realDt;
    f.ragdoll.pelvisPos(_t);
    if (f.isPlayer) {
      // first person fall: look back up at the roof (and the smug winner)
      const head = f.ragdoll.parts[2].curP;
      cam.position.copy(head);
      const o = this.finishOther;
      if (o) {
        o.ragdoll.active ? o.ragdoll.pelvisPos(_p) : _p.set(o.pos.x, o.pos.y + 1.4, o.pos.z);
      } else _p.set(0, 1, 0);
      _m.lookAt(cam.position, _p, UP);
      cam.quaternion.setFromRotationMatrix(_m);
      _e.setFromQuaternion(cam.quaternion, 'YXZ');
      _e.z = Math.sin(this.finishT * 3) * 0.3;
      cam.quaternion.setFromEuler(_e);
      return 70 + Math.min(20, this.finishT * 6);
    }
    // watch the opponent tumble into the void from the edge
    cam.position.lerp(this.finishAnchor, dampFactor(3, realDt));
    _p.copy(cam.position);
    _m.lookAt(_p, _t, UP);
    cam.quaternion.setFromRotationMatrix(_m);
    const d = _p.distanceTo(_t);
    return clamp(70 - d * 0.6, 22, 70);
  }

  private winnerPose() {
    const cam = this.camera;
    const w = this.winner;
    if (!w) return;
    _t.set(w.pos.x, w.pos.y + 1.2, w.pos.z);
    const a = this.time * 0.4;
    cam.position.set(_t.x + Math.sin(a) * 3.2, _t.y + 0.6, _t.z + Math.cos(a) * 3.2);
    _m.lookAt(cam.position, _t, UP);
    cam.quaternion.setFromRotationMatrix(_m);
  }

  private menuPose() {
    const cam = this.camera;
    const a = this.time * 0.05 + 0.6;
    cam.position.set(Math.sin(a) * 23, 9 + Math.sin(this.time * 0.13) * 1.5, Math.cos(a) * 19);
    _m.lookAt(cam.position, _t.set(0, 0.5, 0), UP);
    cam.quaternion.setFromRotationMatrix(_m);
  }

  landDip(speed: number) {
    this.dip.impulse(-Math.min(speed, 12) * 0.12);
  }
}
