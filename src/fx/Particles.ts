import * as THREE from 'three';
import { spriteAtlas, splatAtlas } from '../world/textures';

/**
 * Pooled particle systems — fixed-capacity typed arrays, no allocation per
 * particle, one draw call per pool.
 *
 * - ChunkParticles: lit instanced 3D chunks (blood drops stretched along their
 *   velocity, teeth, debris). Optional floor callback (blood → decal).
 * - SpriteParticles: camera-facing atlas billboards (flash, smoke, sparks,
 *   cartoon stars...), additive or alpha blended.
 * - Decals: fading splats on the roof.
 */

export const enum Sprite {
  Dot = 0,
  Burst = 1,
  Smoke = 2,
  Ring = 3,
  Star = 4,
  Streak = 5,
  Drop = 6,
  Swirl = 7,
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();
const _eu = new THREE.Euler();

export interface ChunkOpts {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.ColorRepresentation;
  size: number;
  life: number;
  gravity?: number;
  drag?: number;
  stretch?: boolean;
  bounce?: number;
  /** spawn a decal when it hits the floor */
  splat?: number;
  spin?: number;
}

export class ChunkParticles {
  readonly mesh: THREE.InstancedMesh;
  private n: number;
  private alive: Uint8Array;
  private pos: Float32Array;
  private vel: Float32Array;
  private rot: Float32Array;
  private spin: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private bounce: Float32Array;
  private flags: Uint8Array;
  private splat: Float32Array;
  private colors: Float32Array;
  private cursor = 0;
  private count = 0;
  onSplat: ((x: number, y: number, z: number, size: number, r: number, g: number, b: number) => void) | null = null;
  floorAt: (x: number, z: number) => number | null = () => null;

  constructor(geometry: THREE.BufferGeometry, capacity: number, material: THREE.Material) {
    this.n = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
    this.alive = new Uint8Array(capacity);
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 3);
    this.spin = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.bounce = new Float32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.splat = new Float32Array(capacity);
    this.colors = new Float32Array(capacity * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  emit(o: ChunkOpts) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.alive[i] = 1;
    this.pos[i * 3] = o.pos.x;
    this.pos[i * 3 + 1] = o.pos.y;
    this.pos[i * 3 + 2] = o.pos.z;
    this.vel[i * 3] = o.vel.x;
    this.vel[i * 3 + 1] = o.vel.y;
    this.vel[i * 3 + 2] = o.vel.z;
    this.rot[i * 3] = Math.random() * 6;
    this.rot[i * 3 + 1] = Math.random() * 6;
    this.rot[i * 3 + 2] = Math.random() * 6;
    this.spin[i] = o.spin ?? 8;
    this.life[i] = o.life;
    this.maxLife[i] = o.life;
    this.size[i] = o.size;
    this.grav[i] = o.gravity ?? 15;
    this.drag[i] = o.drag ?? 0.4;
    this.bounce[i] = o.bounce ?? 0.3;
    this.flags[i] = o.stretch ? 1 : 0;
    this.splat[i] = o.splat ?? 0;
    _c.set(o.color);
    this.colors[i * 3] = _c.r;
    this.colors[i * 3 + 1] = _c.g;
    this.colors[i * 3 + 2] = _c.b;
  }

  update(dt: number) {
    let maxIdx = -1;
    const p = this.pos;
    const v = this.vel;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alive[i] = 0;
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      v[i * 3] *= k;
      v[i * 3 + 2] *= k;
      v[i * 3 + 1] = v[i * 3 + 1] * k - this.grav[i] * dt;
      p[i * 3] += v[i * 3] * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
      const floor = this.floorAt(p[i * 3], p[i * 3 + 2]);
      if (floor !== null && p[i * 3 + 1] < floor && v[i * 3 + 1] < 0 && p[i * 3 + 1] > floor - 0.5) {
        if (this.splat[i] > 0) {
          this.onSplat?.(p[i * 3], floor, p[i * 3 + 2], this.splat[i], this.colors[i * 3], this.colors[i * 3 + 1], this.colors[i * 3 + 2]);
          this.alive[i] = 0;
          continue;
        }
        p[i * 3 + 1] = floor;
        v[i * 3 + 1] *= -this.bounce[i];
        v[i * 3] *= 0.6;
        v[i * 3 + 2] *= 0.6;
        this.spin[i] *= 0.5;
      }
      this.rot[i * 3] += this.spin[i] * dt;
      this.rot[i * 3 + 1] += this.spin[i] * 0.7 * dt;
      maxIdx = i;
    }
    // write matrices for the live range
    const fade = 0.25;
    for (let i = 0; i <= maxIdx; i++) {
      if (!this.alive[i]) {
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        continue;
      }
      const lifeK = Math.min(1, this.life[i] / (this.maxLife[i] * fade));
      const s = this.size[i] * lifeK;
      _v.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      if (this.flags[i] === 1) {
        // stretch along velocity
        _s.set(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
        const sp = _s.length();
        if (sp > 0.01) _q.setFromUnitVectors(_up, _s.divideScalar(sp));
        else _q.identity();
        const st = 1 + Math.min(sp * 0.12, 2.2);
        _m.compose(_v, _q, _s.set(s, s * st, s));
      } else {
        _q.setFromEuler(_eu.set(this.rot[i * 3], this.rot[i * 3 + 1], this.rot[i * 3 + 2]));
        _m.compose(_v, _q, _s.set(s, s, s));
      }
      this.mesh.setMatrixAt(i, _m);
    }
    this.count = maxIdx + 1;
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    this.alive.fill(0);
    this.mesh.count = 0;
  }
}

const SPRITE_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec3 iData; // size, rotation, cell
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iData.y);
  float s = sin(iData.y);
  vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iData.x;
  mvPosition.xy += p;
  gl_Position = projectionMatrix * mvPosition;
  float cell = iData.z;
  vec2 cellUv = vec2(mod(cell, 4.0), 1.0 - floor(cell / 4.0)) * vec2(0.25, 0.5);
  vUv = cellUv + vec2(uv.x * 0.25, uv.y * 0.5);
  vColor = iColor;
  #include <fog_vertex>
}`;

const SPRITE_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vColor.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor.rgb * t.rgb, a);
  #include <fog_fragment>
}`;

export interface SpriteOpts {
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
  cell: Sprite;
  color: THREE.ColorRepresentation;
  alpha?: number;
  size: number;
  /** size at end of life (defaults to size) */
  endSize?: number;
  life: number;
  rot?: number;
  rotSpeed?: number;
  gravity?: number;
  drag?: number;
  /** HDR intensity multiplier (for bloom) */
  intensity?: number;
}

export class SpriteParticles {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private n: number;
  private iPos: THREE.InstancedBufferAttribute;
  private iColor: THREE.InstancedBufferAttribute;
  private iData: THREE.InstancedBufferAttribute;
  private alive: Uint8Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size0: Float32Array;
  private size1: Float32Array;
  private rotSpeed: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private alpha0: Float32Array;
  private cursor = 0;

  constructor(capacity: number, additive: boolean) {
    this.n = capacity;
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.attributes.position);
    this.geo.setAttribute('uv', quad.attributes.uv);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.iColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.iData = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    for (const a of [this.iPos, this.iColor, this.iData]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.iPos);
    this.geo.setAttribute('iColor', this.iColor);
    this.geo.setAttribute('iData', this.iData);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: spriteAtlas() }, ...THREE.UniformsLib.fog },
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 5 : 4;
    this.alive = new Uint8Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.rotSpeed = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.alpha0 = new Float32Array(capacity);
  }

  emit(o: SpriteOpts) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.alive[i] = 1;
    const P = this.iPos.array as Float32Array;
    const C = this.iColor.array as Float32Array;
    const D = this.iData.array as Float32Array;
    P[i * 3] = o.pos.x;
    P[i * 3 + 1] = o.pos.y;
    P[i * 3 + 2] = o.pos.z;
    this.vel[i * 3] = o.vel?.x ?? 0;
    this.vel[i * 3 + 1] = o.vel?.y ?? 0;
    this.vel[i * 3 + 2] = o.vel?.z ?? 0;
    _c.set(o.color).multiplyScalar(o.intensity ?? 1);
    C[i * 4] = _c.r;
    C[i * 4 + 1] = _c.g;
    C[i * 4 + 2] = _c.b;
    C[i * 4 + 3] = o.alpha ?? 1;
    this.alpha0[i] = o.alpha ?? 1;
    D[i * 3] = o.size;
    D[i * 3 + 1] = o.rot ?? Math.random() * Math.PI * 2;
    D[i * 3 + 2] = o.cell;
    this.life[i] = o.life;
    this.maxLife[i] = o.life;
    this.size0[i] = o.size;
    this.size1[i] = o.endSize ?? o.size;
    this.rotSpeed[i] = o.rotSpeed ?? 0;
    this.grav[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 0;
  }

  update(dt: number) {
    const P = this.iPos.array as Float32Array;
    const C = this.iColor.array as Float32Array;
    const D = this.iData.array as Float32Array;
    let maxIdx = -1;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alive[i] = 0;
        C[i * 4 + 3] = 0;
        D[i * 3] = 0;
        continue;
      }
      const t = 1 - this.life[i] / this.maxLife[i];
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 2] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      P[i * 3] += this.vel[i * 3] * dt;
      P[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      P[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      D[i * 3] = this.size0[i] + (this.size1[i] - this.size0[i]) * (1 - (1 - t) * (1 - t));
      D[i * 3 + 1] += this.rotSpeed[i] * dt;
      C[i * 4 + 3] = this.alpha0[i] * (t < 0.1 ? t / 0.1 : 1 - Math.pow((t - 0.1) / 0.9, 1.6));
      maxIdx = i;
    }
    this.geo.instanceCount = maxIdx + 1;
    this.iPos.needsUpdate = true;
    this.iColor.needsUpdate = true;
    this.iData.needsUpdate = true;
  }

  clear() {
    this.alive.fill(0);
    this.geo.instanceCount = 0;
  }
}

const DECAL_VERT = /* glsl */ `
attribute vec4 iColor;
attribute float iCell;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vUv = vec2(uv.x * 0.25 + iCell * 0.25, uv.y);
  vColor = iColor;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const DECAL_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  float a = texture2D(uMap, vUv).a * vColor.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <fog_fragment>
}`;

export class Decals {
  readonly mesh: THREE.InstancedMesh;
  private n: number;
  private cursor = 0;
  private born: Float32Array;
  private ttl: Float32Array;
  private colors: THREE.InstancedBufferAttribute;
  private cells: THREE.InstancedBufferAttribute;
  private time = 0;

  constructor(capacity: number) {
    this.n = capacity;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.cells = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geo.setAttribute('iColor', this.colors);
    geo.setAttribute('iCell', this.cells);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: splatAtlas() }, ...THREE.UniformsLib.fog },
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.born = new Float32Array(capacity).fill(-1000);
    this.ttl = new Float32Array(capacity).fill(1);
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, _m);
  }

  add(x: number, y: number, z: number, size: number, color: THREE.ColorRepresentation, ttl = 28, alpha = 0.92) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    _q.setFromAxisAngle(_up, Math.random() * Math.PI * 2);
    _m.compose(_v.set(x, y + 0.008 + Math.random() * 0.004, z), _q, _s.set(size, 1, size * (0.7 + Math.random() * 0.6)));
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
    _c.set(color);
    const C = this.colors.array as Float32Array;
    C[i * 4] = _c.r;
    C[i * 4 + 1] = _c.g;
    C[i * 4 + 2] = _c.b;
    C[i * 4 + 3] = alpha;
    (this.cells.array as Float32Array)[i] = Math.floor(Math.random() * 4);
    this.cells.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.born[i] = this.time;
    this.ttl[i] = ttl;
  }

  update(dt: number) {
    this.time += dt;
    const C = this.colors.array as Float32Array;
    let dirty = false;
    for (let i = 0; i < this.n; i++) {
      const age = this.time - this.born[i];
      if (age < 0 || age > this.ttl[i] + 1) continue;
      const fadeStart = this.ttl[i] * 0.7;
      if (age > fadeStart) {
        C[i * 4 + 3] = Math.max(0, 0.92 * (1 - (age - fadeStart) / (this.ttl[i] - fadeStart)));
        dirty = true;
      }
    }
    if (dirty) this.colors.needsUpdate = true;
  }

  clear() {
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.n; i++) {
      this.mesh.setMatrixAt(i, _m);
      this.born[i] = -1000;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
