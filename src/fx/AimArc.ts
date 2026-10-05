import * as THREE from 'three';
import type { Fighter } from '../fighters/Fighter';
import { RP } from '../fighters/Ragdoll';

/**
 * Dotted ballistic preview while charging a throw (objects or bodies).
 * Uses Fighter.throwVelocity so the arc is exactly what will happen.
 */
const N = 28;
const G = 15;
const _o = new THREE.Vector3();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class AimArc {
  readonly mesh: THREE.InstancedMesh;
  private t = 0;

  constructor() {
    this.mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.035, 8, 6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.0, 0.5), transparent: true, opacity: 0.85, depthWrite: false }),
      N,
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
  }

  update(dt: number, f: Fighter) {
    const a = f.action;
    const show = !!f.hold && !!a && a.button === 'throw' && a.phase === 'hold' && a.holdTime > 0.12;
    this.mesh.visible = show;
    if (!show || !a || !f.hold) return;
    this.t += dt;
    const charge = Math.min(1, a.holdTime / 0.75);
    f.throwVelocity(charge, _v);
    const gScale = f.hold.kind === 'prop' ? f.hold.prop.def.gravityScale : 1;
    if (f.hold.kind === 'prop') _o.copy(f.hold.prop.curP);
    else _o.copy(f.hold.target.ragdoll.parts[RP.chest].curP);
    const step = 0.055;
    const phase = (this.t * 2.5) % 1;
    let shown = 0;
    for (let i = 0; i < N; i++) {
      const t = (i + phase) * step;
      const x = _o.x + _v.x * t;
      const y = _o.y + _v.y * t - 0.5 * G * gScale * t * t;
      const z = _o.z + _v.z * t;
      if (y < -1.5) break;
      const s = 1 - i / N;
      _m.compose(_p.set(x, y, z), _q, _s.set(s, s, s));
      this.mesh.setMatrixAt(i, _m);
      shown++;
    }
    this.mesh.count = shown;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
