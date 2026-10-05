import * as THREE from 'three';
import { G, groups, RAPIER } from '../physics/Physics';
import type { GameContext } from '../game/Context';
import type { Fighter } from '../fighters/Fighter';
import type { Materials } from '../world/materials';
import { PROP_DEFS, PROP_LAYOUT, PropDef } from './PropDefs';

/**
 * Interactive props: physics bodies + instanced rendering (one draw call per
 * prop type), pick-up/hold/throw plumbing, impacts, breakables & explosives.
 */

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const PROP_GROUPS = groups(G.PROP, G.ALL);

export class Prop {
  heldBy: Fighter | null = null;
  thrownBy: Fighter | null = null;
  thrownTime = -10;
  broken = false;
  readonly prevP = new THREE.Vector3();
  readonly curP = new THREE.Vector3();
  readonly prevQ = new THREE.Quaternion();
  readonly curQ = new THREE.Quaternion();
  readonly prevVel = new THREE.Vector3();
  /** last few pre-step velocities: collision events arrive a step after the solver bounced us */
  private readonly velHist = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private velIdx = 0;
  readonly homeP = new THREE.Vector3();
  readonly homeQ = new THREE.Quaternion();
  lastSound = -10;
  lastHit = new Map<Fighter, number>();
  ignoreTimer = 0;
  /** accumulated punishment (gas cylinders explode after a few hits) */
  damage = 0;

  constructor(
    readonly id: number,
    readonly def: PropDef,
    readonly body: RAPIER.RigidBody,
    readonly collider: RAPIER.Collider,
    readonly instance: number,
  ) {}

  recordVel(x: number, y: number, z: number) {
    this.prevVel.set(x, y, z);
    this.velHist[this.velIdx].set(x, y, z);
    this.velIdx = (this.velIdx + 1) % this.velHist.length;
  }

  clearVelHistory() {
    for (const v of this.velHist) v.set(0, 0, 0);
  }

  /** Highest recent velocity (best estimate of the pre-impact velocity). */
  impactVel(out: THREE.Vector3) {
    let best = 0;
    out.set(0, 0, 0);
    for (const v of this.velHist) {
      const l = v.lengthSq();
      if (l > best) {
        best = l;
        out.copy(v);
      }
    }
    return out;
  }

  get position() {
    return this.curP;
  }
  /** size estimate for targeting */
  get radius() {
    const s = this.def.shape;
    switch (s.type) {
      case 'box':
        return Math.max(s.hx, s.hy, s.hz);
      case 'ball':
        return s.r;
      default:
        return Math.max(s.hh, s.r);
    }
  }
}

export class PropSystem {
  readonly props: Prop[] = [];
  readonly group = new THREE.Group();
  private meshes = new Map<string, THREE.InstancedMesh>();
  private highlight: THREE.Mesh;
  private highlightMat: THREE.MeshBasicMaterial;
  focus: Prop | null = null;
  private time = 0;

  constructor(
    private ctx: GameContext,
    materials: Materials,
  ) {
    this.group.name = 'props';
    // count instances per type
    const counts = new Map<string, number>();
    for (const [id] of PROP_LAYOUT) counts.set(id, (counts.get(id) ?? 0) + 1);
    const geos = new Map<string, THREE.BufferGeometry>();
    for (const [id, n] of counts) {
      const def = PROP_DEFS[id];
      const geo = def.build();
      geos.set(id, geo);
      const mat = def.material === 'metal' ? materials.metal : def.material === 'plastic' ? materials.plastic : materials.matte;
      const im = new THREE.InstancedMesh(geo, mat, n);
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.name = `props:${id}`;
      this.meshes.set(id, im);
      this.group.add(im);
    }
    const used = new Map<string, number>();
    const world = ctx.physics.world;
    PROP_LAYOUT.forEach(([id, x, z, rotY], i) => {
      const def = PROP_DEFS[id];
      const inst = used.get(id) ?? 0;
      used.set(id, inst + 1);
      const { y, q } = spawnPose(def, rotY);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x, y, z)
          .setRotation(q)
          .setLinearDamping(def.linDamping)
          .setAngularDamping(def.angDamping)
          .setGravityScale(def.gravityScale)
          .setCcdEnabled(true)
          .setCanSleep(true),
      );
      const desc = colliderFor(def)
        .setMass(def.mass)
        .setRestitution(def.restitution)
        .setFriction(def.friction)
        .setCollisionGroups(PROP_GROUPS)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const collider = world.createCollider(desc, body);
      const prop = new Prop(i, def, body, collider, inst);
      prop.homeP.set(x, y, z);
      prop.homeQ.copy(q);
      prop.curP.set(x, y, z);
      prop.prevP.set(x, y, z);
      prop.curQ.copy(q);
      prop.prevQ.copy(q);
      ctx.physics.register(collider, { kind: 'prop', ref: prop, material: def.sound });
      this.props.push(prop);
    });

    this.highlightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.9, 0.5), side: THREE.BackSide, transparent: true, opacity: 0.85, depthWrite: false });
    this.highlight = new THREE.Mesh(geos.values().next().value!, this.highlightMat);
    this.highlight.visible = false;
    this.highlight.renderOrder = 2;
    this.group.add(this.highlight);
    this.highlightGeos = geos;

    ctx.physics.onCollision((pair) => {
      if (pair.oa?.kind === 'prop') this.onImpact(pair.oa.ref as Prop, pair.b);
      if (pair.ob?.kind === 'prop') this.onImpact(pair.ob.ref as Prop, pair.a);
    });
    this.render(1);
  }
  private highlightGeos: Map<string, THREE.BufferGeometry>;

  reset() {
    for (const p of this.props) {
      p.heldBy = null;
      p.thrownBy = null;
      p.broken = false;
      p.damage = 0;
      p.lastHit.clear();
      p.ignoreTimer = 0;
      p.clearVelHistory();
      p.body.setEnabled(true);
      p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, false);
      p.collider.setCollisionGroups(PROP_GROUPS);
      p.body.setTranslation(p.homeP, false);
      p.body.setRotation(p.homeQ, false);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      p.body.sleep();
      p.curP.copy(p.homeP);
      p.prevP.copy(p.homeP);
      p.curQ.copy(p.homeQ);
      p.prevQ.copy(p.homeQ);
    }
    this.focus = null;
  }

  // ------------------------------------------------------------------ holding
  grab(prop: Prop, fighter: Fighter) {
    if (prop.broken || prop.heldBy) return false;
    prop.heldBy = fighter;
    prop.thrownBy = null;
    prop.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    const ownR = fighter.index === 0 ? G.R0 : G.R1;
    prop.collider.setCollisionGroups(groups(G.HELD, (G.PROP | G.R0 | G.R1 | G.DEBRIS) & ~ownR));
    return true;
  }

  drive(prop: Prop, pos: THREE.Vector3, quat: THREE.Quaternion) {
    prop.body.setNextKinematicTranslation(pos);
    prop.body.setNextKinematicRotation(quat);
  }

  release(prop: Prop, vel: THREE.Vector3, angVel: THREE.Vector3, thrower: Fighter | null) {
    const holder = prop.heldBy;
    prop.heldBy = null;
    prop.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    prop.body.setLinvel(vel, true);
    prop.body.setAngvel(angVel, true);
    prop.recordVel(vel.x, vel.y, vel.z);
    if (holder) {
      // don't hit the hand that threw you
      prop.collider.setCollisionGroups(groups(G.PROP, G.ALL & ~holder.layer & ~(holder.index === 0 ? G.R0 : G.R1)));
      prop.ignoreTimer = 0.3;
    } else {
      prop.collider.setCollisionGroups(PROP_GROUPS);
    }
    if (thrower) {
      prop.thrownBy = thrower;
      prop.thrownTime = this.ctx.time;
    }
  }

  /** Impulse from a punch/kick/swing. Returns the velocity change. */
  hitProp(prop: Prop, impulse: THREE.Vector3, point: THREE.Vector3, by: Fighter | null) {
    if (prop.broken || prop.heldBy) return 0;
    prop.body.applyImpulseAtPoint(impulse, point, true);
    const dv = impulse.length() / prop.def.mass;
    prop.thrownBy = by;
    prop.thrownTime = this.ctx.time;
    prop.damage += dv;
    const sp = prop.def.special;
    if (sp === 'explode' && (dv > 6 || prop.damage > 14)) this.explode(prop, by);
    else if ((sp === 'break' || sp === 'splat' || sp === 'crumble') && prop.def.breakSpeed && dv > prop.def.breakSpeed * 1.1) this.breakProp(prop);
    return dv;
  }

  // ------------------------------------------------------------------ simulation hooks
  preStep(dt: number) {
    this.time += dt;
    for (const p of this.props) {
      if (p.broken) continue;
      const v = p.body.linvel();
      p.recordVel(v.x, v.y, v.z);
      if (p.ignoreTimer > 0) {
        p.ignoreTimer -= dt;
        if (p.ignoreTimer <= 0 && !p.heldBy) p.collider.setCollisionGroups(PROP_GROUPS);
      }
    }
  }

  postStep() {
    for (const p of this.props) {
      if (p.broken) continue;
      p.prevP.copy(p.curP);
      p.prevQ.copy(p.curQ);
      const t = p.body.translation();
      const r = p.body.rotation();
      p.curP.set(t.x, t.y, t.z);
      p.curQ.set(r.x, r.y, r.z, r.w);
      if (t.y < -126) {
        // landed in the street far below: park it
        p.broken = true;
        p.body.setEnabled(false);
        if (p.heldBy) p.heldBy.releaseHold('drop');
      }
    }
  }

  render(alpha: number) {
    for (const p of this.props) {
      const im = this.meshes.get(p.def.id)!;
      if (p.broken) {
        im.setMatrixAt(p.instance, ZERO);
        continue;
      }
      if (p.heldBy) {
        // kinematic: snap to latest to stay glued to the hand
        _p.lerpVectors(p.prevP, p.curP, alpha);
        _q.slerpQuaternions(p.prevQ, p.curQ, alpha);
      } else {
        _p.lerpVectors(p.prevP, p.curP, alpha);
        _q.slerpQuaternions(p.prevQ, p.curQ, alpha);
      }
      _m.compose(_p, _q, _s);
      im.setMatrixAt(p.instance, _m);
    }
    for (const im of this.meshes.values()) im.instanceMatrix.needsUpdate = true;
    // highlight the focused prop
    const f = this.focus;
    if (f && !f.broken && !f.heldBy) {
      const geo = this.highlightGeos.get(f.def.id)!;
      if (this.highlight.geometry !== geo) this.highlight.geometry = geo;
      this.highlight.visible = true;
      _p.lerpVectors(f.prevP, f.curP, alpha);
      _q.slerpQuaternions(f.prevQ, f.curQ, alpha);
      this.highlight.position.copy(_p);
      this.highlight.quaternion.copy(_q);
      const pulse = 1.07 + Math.sin(this.time * 8) * 0.02;
      this.highlight.scale.setScalar(pulse);
    } else {
      this.highlight.visible = false;
    }
  }

  // ------------------------------------------------------------------ impacts & specials
  private onImpact(prop: Prop, other: RAPIER.Collider) {
    if (prop.broken || prop.heldBy) return;
    const o = this.ctx.physics.owner(other);
    // relative pre-impact speed
    let ov = _v.set(0, 0, 0);
    const ob = other.parent();
    if (ob && ob.isDynamic()) {
      const v = ob.linvel();
      ov.set(v.x, v.y, v.z);
    }
    const speed = prop.impactVel(_p).sub(ov).length();
    const t = this.ctx.time;
    if (speed > 2.2 && t - prop.lastSound > 0.1) {
      prop.lastSound = t;
      this.ctx.events.emit('propImpact', { prop, pos: prop.curP.clone(), speed });
    }
    const def = prop.def;
    const sp = def.special;
    if (!sp || !def.breakSpeed) return;
    // hitting soft bodies counts less than hitting concrete
    const k = o?.kind === 'fighter' || o?.kind === 'ragdoll' ? 0.85 : 1;
    if (speed * k < def.breakSpeed) return;
    if (sp === 'explode') this.explode(prop, prop.thrownBy);
    else if (sp === 'break' || sp === 'splat' || sp === 'crumble') this.breakProp(prop);
  }

  breakProp(prop: Prop) {
    if (prop.broken) return;
    if (prop.heldBy) prop.heldBy.releaseHold('drop');
    prop.broken = true;
    prop.body.setEnabled(false);
    this.ctx.events.emit('propBreak', { prop, pos: prop.curP.clone() });
  }

  explode(prop: Prop, by: Fighter | null) {
    if (prop.broken) return;
    const pos = prop.curP.clone();
    this.breakProp(prop);
    const radius = 5.2;
    // shove every other prop
    for (const p of this.props) {
      if (p.broken || p.heldBy || p === prop) continue;
      const d = p.curP.distanceTo(pos);
      if (d > radius) continue;
      const k = 1 - d / radius;
      _v.subVectors(p.curP, pos).normalize();
      _v.y = Math.abs(_v.y) + 0.6;
      _v.normalize().multiplyScalar(k * 14 * Math.min(p.def.mass, 6));
      p.body.applyImpulse(_v, true);
      p.thrownBy = by;
      p.thrownTime = this.ctx.time;
      // chain reaction!
      if (p.def.special === 'explode' && k > 0.35) {
        const target = p;
        setTimeout(() => this.explode(target, by), 180);
      }
    }
    this.ctx.events.emit('explosion', { pos, radius, by });
  }

  // ------------------------------------------------------------------ queries
  /** Best prop to pick up given an eye ray. */
  findFocus(eye: THREE.Vector3, dir: THREE.Vector3, maxDist = 2.5): Prop | null {
    let best: Prop | null = null;
    let bestScore = Infinity;
    for (const p of this.props) {
      if (p.broken || p.heldBy) continue;
      _v.subVectors(p.curP, eye);
      const along = _v.dot(dir);
      if (along < 0.2 || along > maxDist + p.radius) continue;
      const perp = Math.sqrt(Math.max(0, _v.lengthSq() - along * along));
      const tol = Math.max(0.32, p.radius * 1.1) + along * 0.08;
      if (perp > tol) continue;
      const score = along + perp * 3;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  nearest(pos: THREE.Vector3, filter: (p: Prop) => boolean, maxDist = 30): Prop | null {
    let best: Prop | null = null;
    let bd = maxDist;
    for (const p of this.props) {
      if (p.broken || p.heldBy || !filter(p)) continue;
      const d = Math.hypot(p.curP.x - pos.x, p.curP.z - pos.z);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }
}

function colliderFor(def: PropDef) {
  const s = def.shape;
  switch (s.type) {
    case 'box':
      return RAPIER.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
    case 'ball':
      return RAPIER.ColliderDesc.ball(s.r);
    case 'cyl':
      return RAPIER.ColliderDesc.cylinder(s.hh, s.r);
    case 'capsule':
      return RAPIER.ColliderDesc.capsule(s.hh, s.r);
    case 'cone':
      // our cone mesh has its tip pointing down (-Y) like a handle
      return RAPIER.ColliderDesc.cone(s.hh, s.r).setRotation({ x: 1, y: 0, z: 0, w: 0 });
  }
}

/** Spawn height + rotation (long things lie down). */
function spawnPose(def: PropDef, rotY: number) {
  const s = def.shape;
  const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
  const lie = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  let y = 0.3;
  let lying = false;
  switch (s.type) {
    case 'box':
      lying = s.hy > Math.max(s.hx, s.hz) * 1.6;
      y = lying ? s.hx : s.hy;
      if (def.id === 'stop' || def.id === 'plank' || def.id === 'chair') {
        // lay flat on the big face
        const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
        return { y: s.hz + 0.03, q: qy.multiply(flat) };
      }
      break;
    case 'ball':
      y = s.r;
      break;
    case 'cyl':
      y = s.hh;
      if (def.id === 'tire') {
        return { y: s.hh + 0.02, q: qy };
      }
      break;
    case 'capsule':
      lying = s.hh > s.r * 1.2 && def.id !== 'gas' && def.id !== 'gnome';
      y = lying ? s.r : s.hh + s.r;
      break;
    case 'cone':
      y = s.hh;
      // stand on its base (base is +Y in our model → flip)
      return { y: s.hh + 0.03, q: qy.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)) };
  }
  return { y: y + 0.03, q: lying ? qy.multiply(lie) : qy };
}
