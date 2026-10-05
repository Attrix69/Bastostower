import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { clamp, dampFactor, Spring } from '../core/math';
import { GUARD_L, GUARD_R, HEAVY_THRESHOLD, samplePath } from '../fighters/attacks';
import type { Fighter } from '../fighters/Fighter';
import { FState } from '../fighters/states';
import type { CharacterLook } from '../fighters/Characters';

/**
 * First-person arms & leg, rendered in a separate scene (no wall clipping,
 * fixed FOV). Fists follow EXACTLY the same aim-space trajectories used by the
 * hit detection, so what you see is what hits. Adds weapon sway/inertia,
 * movement bob, charge tremble and hit flinches on top.
 */

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _off = new THREE.Vector3();
const _sh = new THREE.Vector3();
const _el = new THREE.Vector3();
const _wr = new THREE.Vector3();
const _fi = new THREE.Vector3();
const _bv = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

interface Arm {
  root: THREE.Group;
  upper: THREE.Mesh;
  fore: THREE.Mesh;
  fist: THREE.Group;
  cur: THREE.Vector3;
  side: number;
}

export class ViewModel {
  readonly group = new THREE.Group();
  private arms: Arm[] = [];
  private leg: THREE.Group;
  private thigh: THREE.Mesh;
  private shin: THREE.Mesh;
  private shoe: THREE.Mesh;
  private swayX = new Spring(90, 11);
  private swayY = new Spring(90, 11);
  private flinch = new Spring(140, 10);
  private time = 0;
  private sun: THREE.DirectionalLight;
  private kickW = 0;
  private lastYaw = 0;
  private lastPitch = 0;

  constructor(
    scene: THREE.Scene,
    look: CharacterLook,
    envMap: THREE.Texture | null,
  ) {
    scene.add(this.group);
    const hemi = new THREE.HemisphereLight(0x9aa0e8, 0x4a3a3a, 1.2);
    this.sun = new THREE.DirectionalLight(0xffc090, 2.6);
    scene.add(hemi, this.sun, this.sun.target);
    if (envMap) scene.environment = envMap;

    const skin = new THREE.MeshStandardMaterial({ color: look.skin, roughness: 0.6 });
    const sleeve = new THREE.MeshStandardMaterial({ color: look.shirt, roughness: 0.85 });
    const glove = new THREE.MeshStandardMaterial({ color: look.gloves, roughness: 0.45 });
    const tape = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.9 });
    const cuff = new THREE.MeshStandardMaterial({ color: look.shirtAccent, roughness: 0.8 });

    for (const side of [-1, 1]) {
      const root = new THREE.Group();
      const upperGeo = new THREE.CylinderGeometry(0.075, 0.07, 1, 14);
      upperGeo.translate(0, 0.5, 0);
      const upper = new THREE.Mesh(upperGeo, sleeve);
      const foreGeo = new THREE.CylinderGeometry(0.058, 0.07, 1, 14);
      foreGeo.translate(0, 0.5, 0);
      const fore = new THREE.Mesh(foreGeo, sleeve);
      const fist = new THREE.Group();
      const fistMesh = new THREE.Mesh(new RoundedBoxGeometry(0.15, 0.135, 0.165, 3, 0.05), glove);
      const knuckles = new THREE.Mesh(new RoundedBoxGeometry(0.155, 0.05, 0.06, 2, 0.02), tape);
      knuckles.position.set(0, 0.035, -0.06);
      const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 10), glove);
      thumb.position.set(side * -0.07, -0.02, -0.03);
      const cuffMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.072, 0.05, 14), cuff);
      cuffMesh.rotation.x = Math.PI / 2;
      cuffMesh.position.z = 0.09;
      const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.056, 0.06, 12), skin);
      wrist.rotation.x = Math.PI / 2;
      wrist.position.z = 0.07;
      fist.add(fistMesh, knuckles, thumb, wrist, cuffMesh);
      root.add(upper, fore, fist);
      this.group.add(root);
      this.arms.push({ root, upper, fore, fist, cur: new THREE.Vector3(...(side < 0 ? GUARD_L : GUARD_R)), side });
    }

    // kicking leg
    this.leg = new THREE.Group();
    const pants = new THREE.MeshStandardMaterial({ color: look.pants, roughness: 0.85 });
    const shoeMat = new THREE.MeshStandardMaterial({ color: look.shoes, roughness: 0.5 });
    const tg = new THREE.CylinderGeometry(0.1, 0.11, 1, 14);
    tg.translate(0, 0.5, 0);
    this.thigh = new THREE.Mesh(tg, pants);
    const sg = new THREE.CylinderGeometry(0.075, 0.09, 1, 14);
    sg.translate(0, 0.5, 0);
    this.shin = new THREE.Mesh(sg, pants);
    this.shoe = new THREE.Mesh(new RoundedBoxGeometry(0.15, 0.13, 0.32, 3, 0.05), shoeMat);
    const sole = new THREE.Mesh(new RoundedBoxGeometry(0.155, 0.035, 0.33, 2, 0.012), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }));
    sole.position.y = -0.06;
    this.shoe.add(sole);
    this.leg.add(this.thigh, this.shin, this.shoe);
    this.leg.visible = false;
    this.group.add(this.leg);
  }

  flinchHit(power: number) {
    this.flinch.impulse(power * 3);
  }

  /** Orient a unit-length (Y-up) cylinder mesh from a to b. */
  private bone(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
    _bv.subVectors(b, a);
    const len = _bv.length();
    mesh.position.copy(a);
    _q.setFromUnitVectors(UP, _bv.divideScalar(len || 1));
    mesh.quaternion.copy(_q);
    mesh.scale.set(1, len, 1);
  }

  update(realDt: number, alpha: number, f: Fighter, cam: THREE.Camera, sunDir: THREE.Vector3, yaw: number, pitch: number, bob: THREE.Vector3, visible: boolean) {
    this.group.visible = visible;
    if (!visible) return;
    this.time += realDt;
    const dt = Math.min(realDt, 0.05);
    // sun direction in camera space
    _v.copy(sunDir).applyQuaternion(_q.copy(cam.quaternion).invert());
    this.sun.position.copy(_v).multiplyScalar(10);
    this.sun.target.position.set(0, 0, 0);

    // inertia sway from mouse movement
    const dyaw = yaw - this.lastYaw;
    const dpitch = pitch - this.lastPitch;
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    this.swayX.impulse(clamp(dyaw, -0.2, 0.2) * 2.2);
    this.swayY.impulse(clamp(-dpitch, -0.2, 0.2) * 2.2);
    this.swayX.update(dt);
    this.swayY.update(dt);
    this.flinch.update(dt);
    const breathe = Math.sin(this.time * 1.8) * 0.006;
    const off = _off.set(this.swayX.value * 0.06 + bob.x * 0.6, this.swayY.value * 0.06 + bob.y * 0.7 + breathe - this.flinch.value * 0.03, this.flinch.value * 0.04);

    const a = f.action;
    const hold = f.hold;
    const stunned = f.state === FState.Stunned;
    const k = dampFactor(a ? 30 : 16, dt);
    for (const arm of this.arms) {
      const left = arm.side < 0;
      const des = _a.set(...(left ? GUARD_L : GUARD_R));
      let exact = false;
      if (f.blocking) des.set(left ? -0.1 : 0.11, -0.05, -0.27);
      if (hold?.kind === 'prop') {
        if (hold.twoHanded) {
          const pull = a && a.button === 'throw' ? (a.phase === 'hold' ? 0.22 : -0.25) : 0;
          des.set(left ? -0.22 : 0.22, -0.28 + pull * 0.4, -0.55 + pull);
        } else if (!left) des.set(0.24, -0.27, -0.42);
      } else if (hold?.kind === 'fighter') {
        if (hold.mode === 'carry') des.set(left ? -0.3 : 0.3, 0.1 + Math.sin(this.time * 3) * 0.015, -0.38);
        else if (!left) des.set(0.14, -0.3, -0.62);
      }
      if (a && (a.def.limb === (left ? 'handL' : 'handR') || (a.def.limb === 'weapon' && !left))) {
        const t = a.phase === 'hold' ? 0 : a.t + alpha * (1 / 60);
        samplePath(a.def.path, Math.min(t, a.def.duration), des);
        if (a.phase === 'hold' && a.holdTime > HEAVY_THRESHOLD) {
          const tr = Math.min(1, (a.holdTime - HEAVY_THRESHOLD) / 0.6) * 0.008;
          des.x += (Math.random() - 0.5) * tr;
          des.y += (Math.random() - 0.5) * tr;
        }
        exact = a.phase === 'strike';
      }
      if (a && hold?.kind === 'fighter' && hold.mode === 'carry' && a.button === 'throw') {
        const fk = a.phase === 'hold' ? -0.1 : Math.min(1, a.t / 0.1);
        des.set(left ? -0.3 : 0.3, 0.1 - fk * 0.3, -0.38 - fk * 0.35);
        exact = false;
      }
      if (stunned && !a) {
        des.y -= 0.12 + Math.sin(this.time * 2 + arm.side) * 0.04;
        des.x += Math.sin(this.time * 1.3) * 0.04;
      }
      if (exact) arm.cur.copy(des);
      else arm.cur.lerp(des, k);

      // shoulder (off screen) → elbow → fist
      const fist = _fi.copy(arm.cur).add(off);
      const shoulder = _sh.set(arm.side * 0.24, -0.42, 0.18);
      const elbow = _el.copy(shoulder).lerp(fist, 0.5);
      elbow.x += arm.side * 0.07;
      elbow.y -= 0.1;
      this.bone(arm.upper, shoulder, elbow);
      // forearm ends at the wrist, slightly behind the fist center
      const wrist = _wr.subVectors(fist, elbow).normalize().multiplyScalar(-0.07).add(fist);
      this.bone(arm.fore, elbow, wrist);
      arm.fist.position.copy(fist);
      _m.lookAt(elbow, fist, UP);
      arm.fist.quaternion.setFromRotationMatrix(_m);
      arm.fist.rotateZ(arm.side * 0.25);
    }

    // kick leg: foot trajectory (body frame) → world → camera space
    const kicking = a && a.def.limb === 'footR';
    this.kickW += ((kicking ? 1 : 0) - this.kickW) * dampFactor(kicking ? 40 : 14, dt);
    this.leg.visible = this.kickW > 0.02;
    if (this.leg.visible && a) {
      const t = a.phase === 'hold' ? 0 : a.t + alpha * (1 / 60);
      samplePath(a.def.path, Math.min(t, a.def.duration), _v);
      f.framePoint('body', _v, _a);
      cam.worldToLocal(_a);
      // drop the leg out of view when blending out
      _a.y -= (1 - this.kickW) * 0.6;
      const hip = _b.set(0.14, -1.0, 0.25);
      const knee = new THREE.Vector3().lerpVectors(hip, _a, 0.5);
      knee.y += 0.18;
      knee.z -= 0.05;
      this.bone(this.thigh, hip, knee);
      this.bone(this.shin, knee, _a);
      this.shoe.position.copy(_a);
      _m.lookAt(knee, _a, UP);
      this.shoe.quaternion.setFromRotationMatrix(_m);
      this.shoe.rotateX(-Math.PI / 2 + 0.3);
    }
  }
}
