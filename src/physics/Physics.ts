import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export { RAPIER };

/**
 * Collision layers (16 bits). Each fighter owns two layers: its kinematic
 * capsule and its ragdoll, so we can e.g. let a carried body ignore its carrier.
 */
export const G = {
  STATIC: 1 << 0,
  PROP: 1 << 1,
  F0: 1 << 2,
  F1: 1 << 3,
  R0: 1 << 4,
  R1: 1 << 5,
  DEBRIS: 1 << 6,
  HELD: 1 << 7,
  ALL: 0xffff,
} as const;

export const groups = (membership: number, filter: number) => ((membership & 0xffff) << 16) | (filter & 0xffff);

export type OwnerKind = 'static' | 'prop' | 'fighter' | 'ragdoll' | 'railing';

export interface ColliderOwner {
  kind: OwnerKind;
  /** owning object (Prop, Fighter, RailingSegment...) */
  ref: any;
  /** ragdoll part index, prop id, ... */
  part?: number;
  /** surface tag used for impact sounds */
  material?: string;
}

export interface CollisionPair {
  a: RAPIER.Collider;
  b: RAPIER.Collider;
  oa: ColliderOwner | undefined;
  ob: ColliderOwner | undefined;
}

export interface ForcePair extends CollisionPair {
  force: number;
}

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  collider: RAPIER.Collider;
  owner?: ColliderOwner;
}

/** Thin wrapper around the Rapier world: owner registry, event routing and handy queries. */
export class Physics {
  readonly world: RAPIER.World;
  private queue: RAPIER.EventQueue;
  private owners = new Map<number, ColliderOwner>();
  private collisionListeners: ((p: CollisionPair) => void)[] = [];
  private forceListeners: ((p: ForcePair) => void)[] = [];
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  static async init() {
    await RAPIER.init();
    return new Physics();
  }

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -15, z: 0 });
    this.world.integrationParameters.numSolverIterations = 6;
    this.queue = new RAPIER.EventQueue(true);
  }

  register(collider: RAPIER.Collider, owner: ColliderOwner) {
    this.owners.set(collider.handle, owner);
  }

  unregister(collider: RAPIER.Collider) {
    this.owners.delete(collider.handle);
  }

  owner(collider: RAPIER.Collider | number): ColliderOwner | undefined {
    return this.owners.get(typeof collider === 'number' ? collider : collider.handle);
  }

  onCollision(fn: (p: CollisionPair) => void) {
    this.collisionListeners.push(fn);
  }

  onContactForce(fn: (p: ForcePair) => void) {
    this.forceListeners.push(fn);
  }

  step(dt: number) {
    // Rapier is happy with small dt (slow motion) but needs a sane lower bound.
    this.world.timestep = Math.max(dt, 1 / 2000);
    this.world.step(this.queue);
    this.queue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = this.world.getCollider(h1);
      const b = this.world.getCollider(h2);
      if (!a || !b) return;
      const p: CollisionPair = { a, b, oa: this.owners.get(h1), ob: this.owners.get(h2) };
      for (const fn of this.collisionListeners) fn(p);
    });
    this.queue.drainContactForceEvents((ev) => {
      const a = this.world.getCollider(ev.collider1());
      const b = this.world.getCollider(ev.collider2());
      if (!a || !b) return;
      const p: ForcePair = {
        a,
        b,
        oa: this.owners.get(a.handle),
        ob: this.owners.get(b.handle),
        force: ev.totalForceMagnitude(),
      };
      for (const fn of this.forceListeners) fn(p);
    });
  }

  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    filterGroups?: number,
    predicate?: (c: RAPIER.Collider) => boolean,
    out?: RayHit,
  ): RayHit | null {
    this.ray.origin.x = origin.x;
    this.ray.origin.y = origin.y;
    this.ray.origin.z = origin.z;
    this.ray.dir.x = dir.x;
    this.ray.dir.y = dir.y;
    this.ray.dir.z = dir.z;
    const hit = this.world.castRayAndGetNormal(this.ray, maxDist, true, undefined, filterGroups, undefined, undefined, predicate);
    if (!hit) return null;
    const res: RayHit = out ?? { point: new THREE.Vector3(), normal: new THREE.Vector3(), distance: 0, collider: hit.collider };
    res.distance = hit.timeOfImpact;
    res.point.copy(origin).addScaledVector(dir, hit.timeOfImpact);
    res.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
    res.collider = hit.collider;
    res.owner = this.owners.get(hit.collider.handle);
    return res;
  }

  /** Iterate colliders overlapping a ball. Return false from cb to stop. */
  overlapBall(center: THREE.Vector3, radius: number, filterGroups: number, cb: (c: RAPIER.Collider) => boolean) {
    const shape = new RAPIER.Ball(radius);
    this.world.intersectionsWithShape(center, { x: 0, y: 0, z: 0, w: 1 }, shape, cb, undefined, filterGroups);
  }
}
