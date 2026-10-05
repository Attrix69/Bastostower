import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Geometry helpers: world-space UV tiling for boxes, baked vertex colors and a
 * static batcher that merges everything sharing a material into one draw call.
 */

/** Box whose UVs are in meters / tile so textures keep a constant texel density. */
export function tiledBox(w: number, h: number, d: number, tile = 1) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // face order: +x, -x, +y, -y, +z, -z (4 verts each)
  const dims: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, (uv.getX(idx) * dims[f][0]) / tile, (uv.getY(idx) * dims[f][1]) / tile);
    }
  }
  return g;
}

export function roundedBox(w: number, h: number, d: number, r: number, seg = 2) {
  return new RoundedBoxGeometry(w, h, d, seg, Math.min(r, Math.min(w, h, d) / 2 - 0.001));
}

/** Ensure non-indexed/indexed compatibility for merging: keep only position/normal/uv + color. */
export function normalizeForMerge(g: THREE.BufferGeometry, color?: THREE.ColorRepresentation) {
  let geo = g;
  // drop attributes we don't use to make merges compatible
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') geo.deleteAttribute(name);
  }
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!geo.index) {
    // keep everything indexed for consistency
    const n = geo.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (color !== undefined || !geo.attributes.color) {
    const c = new THREE.Color(color ?? 0xffffff);
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  }
  geo.groups.length = 0;
  return geo;
}

/** Bake a transform + flat color into a geometry clone. */
export function part(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, m?: THREE.Matrix4) {
  const geo = normalizeForMerge(g.index ? g.clone() : g.clone(), color);
  if (m) geo.applyMatrix4(m);
  return geo;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
export function mat(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q, _s);
}

export function merge(parts: THREE.BufferGeometry[]) {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('merge failed');
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

interface BatchEntry {
  material: THREE.Material;
  parts: THREE.BufferGeometry[];
  castShadow: boolean;
  receiveShadow: boolean;
}

/**
 * Collects static geometry per material and emits one merged mesh per
 * (material, shadow-flags) pair. Massive draw-call reduction for the rooftop.
 */
export class StaticBatcher {
  private entries = new Map<string, BatchEntry>();

  add(
    key: string,
    material: THREE.Material,
    geometry: THREE.BufferGeometry,
    matrix: THREE.Matrix4 | null,
    opts: { color?: THREE.ColorRepresentation; cast?: boolean; receive?: boolean } = {},
  ) {
    const cast = opts.cast ?? true;
    const receive = opts.receive ?? true;
    const k = `${key}|${cast ? 1 : 0}${receive ? 1 : 0}`;
    let e = this.entries.get(k);
    if (!e) {
      e = { material, parts: [], castShadow: cast, receiveShadow: receive };
      this.entries.set(k, e);
    }
    const geo = normalizeForMerge(geometry.clone(), opts.color ?? 0xffffff);
    if (matrix) geo.applyMatrix4(matrix);
    e.parts.push(geo);
  }

  build(parent: THREE.Object3D) {
    for (const [k, e] of this.entries) {
      if (!e.parts.length) continue;
      const mesh = new THREE.Mesh(merge(e.parts), e.material);
      mesh.name = `static:${k}`;
      mesh.castShadow = e.castShadow;
      mesh.receiveShadow = e.receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      for (const p of e.parts) p.dispose();
    }
    this.entries.clear();
  }
}

export { _m as scratchMatrix };
