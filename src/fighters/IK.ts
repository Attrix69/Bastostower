import * as THREE from 'three';

/**
 * Analytic two-bone IK (shoulder/elbow/wrist, hip/knee/ankle) with optional
 * cartoon stretch: when the target is out of reach the limb stretches up to
 * `maxStretch`, so the visible fist/foot always matches the real hitbox.
 *
 * Bone convention (see Rig): limbs point down local -Y, the joint bends around
 * local X. Arms bend toward local -Z (positive angle), legs toward +Z (negative).
 */

const _S = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _up = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _qw = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);

export interface IKResult {
  stretch: number;
}

export function solveTwoBone(
  upper: THREE.Bone,
  lower: THREE.Bone,
  end: THREE.Bone,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  lenA: number,
  lenB: number,
  isLeg: boolean,
  maxStretch = 1.3,
  weight = 1,
): number {
  _S.setFromMatrixPosition(upper.matrixWorld);
  _dir.subVectors(target, _S);
  let dist = _dir.length();
  if (dist < 1e-4) return 1;
  _dir.divideScalar(dist);

  const full = lenA + lenB;
  let stretch = 1;
  if (dist > full * 0.999) {
    stretch = Math.min(maxStretch, dist / (full * 0.999));
  }
  const a = lenA * stretch;
  const b = lenB * stretch;
  dist = Math.min(dist, (a + b) * 0.999);
  dist = Math.max(dist, Math.abs(a - b) + 1e-3);

  // bend plane direction (toward the pole, perpendicular to the target dir)
  _pole.subVectors(pole, _S);
  _pole.addScaledVector(_dir, -_pole.dot(_dir));
  if (_pole.lengthSq() < 1e-8) {
    _pole.set(0, -1, 0).addScaledVector(_dir, -_dir.y);
    if (_pole.lengthSq() < 1e-8) _pole.set(1, 0, 0);
  }
  _pole.normalize();

  const cosA = THREE.MathUtils.clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  // upper bone direction
  _up.copy(_dir).multiplyScalar(cosA).addScaledVector(_pole, sinA).normalize();
  // the lower bone bends away from the pole side
  _bend.copy(_pole).multiplyScalar(-1).addScaledVector(_up, _pole.dot(_up)).normalize();

  const cosE = THREE.MathUtils.clamp((a * a + b * b - dist * dist) / (2 * a * b), -1, 1);
  const elbow = Math.PI - Math.acos(cosE);

  // basis for the upper bone: Y = -upperDir, Z = ±bend
  _y.copy(_up).negate();
  if (isLeg) _z.copy(_bend);
  else _z.copy(_bend).negate();
  _x.crossVectors(_y, _z).normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  _qw.setFromRotationMatrix(_m);

  // to local space
  upper.parent!.getWorldQuaternion(_qp);
  _qp.invert().multiply(_qw);
  if (weight >= 1) upper.quaternion.copy(_qp);
  else upper.quaternion.slerp(_qp, weight);
  const angle = isLeg ? -elbow : elbow;
  _qw.setFromAxisAngle(_axisX, angle);
  if (weight >= 1) lower.quaternion.copy(_qw);
  else lower.quaternion.slerp(_qw, weight);

  // stretch (scale along bone Y); compensate the end effector
  upper.scale.set(1, stretch, 1);
  lower.scale.set(1, 1, 1);
  if (stretch !== 1) {
    // lower bone inherits parent scale; its own length must stretch as well, so keep scale 1 (inherits) and
    // un-stretch the end effector so fists/feet keep their size.
    end.scale.set(1, 1 / stretch, 1);
  } else {
    end.scale.set(1, 1, 1);
  }
  return stretch;
}
