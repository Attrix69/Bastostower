import * as THREE from 'three';
import { createBuildingMaterial } from './buildingMaterial';
import { softDotTexture, textTexture } from './textures';

/**
 * Background city. Everything is instanced and mostly shader-animated:
 * - buildings: a few InstancedMeshes split in angular sectors so off-screen sectors get frustum-culled
 * - rooftop clutter (tanks, boxes) only on nearby buildings (cheap LOD)
 * - traffic: car lights animated entirely in the vertex shader (zero CPU)
 * - blinking aircraft beacons on tall towers, shader-driven
 */

const STREET_Y = -120;
const BLOCK = 46;
const STREET_W = 14;

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Building {
  x: number;
  z: number;
  w: number;
  d: number;
  top: number;
  color: THREE.Color;
}

const FACADE_COLORS = [0xb8a48c, 0x9e8f86, 0x8c8f99, 0xa2604a, 0xc9b69a, 0x6f7584, 0x7f6b63, 0xd2c3ad, 0x5d6370, 0x94786a];

export class City {
  readonly group = new THREE.Group();
  private carMat: THREE.ShaderMaterial;
  private beaconMat: THREE.ShaderMaterial;
  readonly buildingMaterial = createBuildingMaterial({ litRatio: 0.4 });

  constructor(fog: THREE.FogExp2, density = 1) {
    this.group.name = 'city';
    const rnd = mulberry(1337);
    const buildings: Building[] = [];
    const R = 760 * Math.sqrt(density);
    const n = Math.ceil(R / BLOCK);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        if (i === 0 && j === 0) continue; // our tower's block
        const bx = i * BLOCK;
        const bz = j * BLOCK;
        const dist = Math.hypot(bx, bz);
        if (dist > R) continue;
        const inner = BLOCK - STREET_W;
        const split = rnd();
        const lots: [number, number, number, number][] = [];
        if (split < 0.3) lots.push([bx, bz, inner, inner]);
        else if (split < 0.65) {
          lots.push([bx - inner / 4, bz, inner / 2, inner]);
          lots.push([bx + inner / 4, bz, inner / 2, inner]);
        } else {
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) lots.push([bx + (sx * inner) / 4, bz + (sz * inner) / 4, inner / 2, inner / 2]);
        }
        for (const [lx, lz, lw, ld] of lots) {
          const set = 0.5 + rnd() * 2.5;
          const w = lw - set * 2;
          const d = ld - set * 2;
          let top: number;
          const r = rnd();
          if (dist < 80) top = r < 0.12 ? -8 + rnd() * 20 : -100 + rnd() * 72;
          else if (dist < 260) top = r < 0.12 ? 18 + rnd() * 90 : -100 + rnd() * 110;
          else top = r < 0.14 ? 30 + rnd() * 150 : -95 + rnd() * 120;
          const color = new THREE.Color(FACADE_COLORS[Math.floor(rnd() * FACADE_COLORS.length)]);
          color.offsetHSL(0, 0, (rnd() - 0.5) * 0.08);
          buildings.push({ x: lx, z: lz, w, d, top, color });
          // stepped setback towers on tall buildings
          if (top > 20 && rnd() < 0.6) {
            const k = 0.55 + rnd() * 0.2;
            buildings.push({ x: lx, z: lz, w: w * k, d: d * k, top: top + 12 + rnd() * 30, color: color.clone().offsetHSL(0, 0, -0.04) });
          }
        }
      }
    }

    // --- buildings: split into 8 angular sectors for frustum culling
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const sectors: Building[][] = Array.from({ length: 8 }, () => []);
    for (const b of buildings) {
      const a = Math.atan2(b.z, b.x) + Math.PI;
      sectors[Math.min(7, Math.floor((a / (Math.PI * 2)) * 8))].push(b);
    }
    const m = new THREE.Matrix4();
    for (const list of sectors) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(box, this.buildingMaterial, list.length);
      list.forEach((b, k) => {
        const h = b.top - STREET_Y;
        m.makeScale(b.w, h, b.d).setPosition(b.x, STREET_Y, b.z);
        im.setMatrixAt(k, m);
        im.setColorAt(k, b.color);
      });
      im.computeBoundingSphere();
      im.castShadow = false;
      im.receiveShadow = false;
      this.group.add(im);
    }

    // --- roof caps & clutter on nearby buildings (LOD: only within 220 m)
    const near = buildings.filter((b) => Math.hypot(b.x, b.z) < 220);
    const capMat = new THREE.MeshStandardMaterial({ color: 0x55535a, roughness: 0.9 });
    const caps = new THREE.InstancedMesh(box, capMat, near.length * 3);
    let ci = 0;
    const tankGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
    tankGeo.translate(0, 0.5, 0);
    const tankMat = new THREE.MeshStandardMaterial({ color: 0x8a6a50, roughness: 0.85 });
    const tanks = new THREE.InstancedMesh(tankGeo, tankMat, near.length);
    let ti = 0;
    for (const b of near) {
      m.makeScale(b.w + 0.6, 0.6, b.d + 0.6).setPosition(b.x, b.top, b.z);
      caps.setMatrixAt(ci++, m);
      if (rnd() < 0.7) {
        const s = 2 + rnd() * 3;
        m.makeScale(s, 1.2 + rnd() * 1.5, s * 0.8).setPosition(b.x + (rnd() - 0.5) * b.w * 0.5, b.top + 0.6, b.z + (rnd() - 0.5) * b.d * 0.5);
        caps.setMatrixAt(ci++, m);
      }
      if (rnd() < 0.35) {
        const s = 2.5 + rnd() * 1.5;
        m.makeScale(s, s * 1.2, s).setPosition(b.x + (rnd() - 0.5) * b.w * 0.4, b.top + 2.2, b.z + (rnd() - 0.5) * b.d * 0.4);
        tanks.setMatrixAt(ti++, m);
      }
    }
    caps.count = ci;
    tanks.count = ti;
    caps.computeBoundingSphere();
    tanks.computeBoundingSphere();
    this.group.add(caps, tanks);

    // --- aircraft beacons on tall buildings (shader blink)
    const tall = buildings.filter((b) => b.top > 25);
    const beaconGeo = new THREE.OctahedronGeometry(0.8, 0);
    this.beaconMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aPhase;
        varying float vB;
        uniform float uTime;
        void main() {
          vB = step(0.82, fract(uTime * 0.6 + aPhase));
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position * (0.6 + 0.0015 * length((modelViewMatrix * instanceMatrix * vec4(0,0,0,1)).xyz)), 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vB;
        void main() { gl_FragColor = vec4(vec3(6.0, 0.25, 0.15) * (0.08 + vB), 1.0); }`,
    });
    const beacons = new THREE.InstancedMesh(beaconGeo, this.beaconMat, tall.length);
    const phases = new Float32Array(tall.length);
    tall.forEach((b, k) => {
      m.makeTranslation(b.x, b.top + 1.5, b.z);
      beacons.setMatrixAt(k, m);
      phases[k] = rnd();
    });
    beaconGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    beacons.frustumCulled = false;
    this.group.add(beacons);

    // --- street ground
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2 * R + 200, 2 * R + 200), new THREE.MeshStandardMaterial({ color: 0x1b1b22, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = STREET_Y;
    this.group.add(ground);

    // --- traffic: lanes along street grid, cars animated in the vertex shader
    const lanes: { ox: number; oz: number; dx: number; dz: number; len: number }[] = [];
    for (let i = -n; i <= n; i++) {
      const c = i * BLOCK + BLOCK / 2;
      if (Math.abs(c) > R * 0.8) continue;
      const L = R * 1.4;
      lanes.push({ ox: c - 3, oz: -L / 2, dx: 0, dz: 1, len: L });
      lanes.push({ ox: c + 3, oz: L / 2, dx: 0, dz: -1, len: L });
      lanes.push({ ox: -L / 2, oz: c - 3, dx: 1, dz: 0, len: L });
      lanes.push({ ox: L / 2, oz: c + 3, dx: -1, dz: 0, len: L });
    }
    const carsPerLane = Math.round(9 * density);
    const total = lanes.length * carsPerLane * 2;
    const carGeo = new THREE.PlaneGeometry(1, 1);
    const inst = new THREE.InstancedBufferGeometry();
    inst.index = carGeo.index;
    inst.attributes.position = carGeo.attributes.position;
    inst.attributes.uv = carGeo.attributes.uv;
    const aLane = new Float32Array(total * 4);
    const aDir = new Float32Array(total * 4);
    const aCol = new Float32Array(total * 3);
    let k = 0;
    for (const l of lanes) {
      const speed = 9 + rnd() * 7;
      for (let c = 0; c < carsPerLane; c++) {
        const off = rnd() * l.len;
        // headlights (white, facing travel) and taillights (red) are the same car seen from either end:
        for (let e = 0; e < 2; e++) {
          aLane[k * 4] = l.ox;
          aLane[k * 4 + 1] = l.oz;
          aLane[k * 4 + 2] = l.len;
          aLane[k * 4 + 3] = off + e * 3.8;
          aDir[k * 4] = l.dx;
          aDir[k * 4 + 1] = l.dz;
          aDir[k * 4 + 2] = speed;
          aDir[k * 4 + 3] = e;
          const head = e === 1;
          aCol[k * 3] = head ? 4 : 4;
          aCol[k * 3 + 1] = head ? 3.6 : 0.25;
          aCol[k * 3 + 2] = head ? 2.8 : 0.15;
          k++;
        }
      }
    }
    inst.setAttribute('aLane', new THREE.InstancedBufferAttribute(aLane, 4));
    inst.setAttribute('aDir', new THREE.InstancedBufferAttribute(aDir, 4));
    inst.setAttribute('aCol', new THREE.InstancedBufferAttribute(aCol, 3));
    inst.instanceCount = total;
    this.carMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: softDotTexture() },
        fogColor: { value: fog.color },
        fogDensity: { value: fog.density },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec4 aLane;
        attribute vec4 aDir;
        attribute vec3 aCol;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vFogDepth;
        void main() {
          float t = mod(aLane.w + uTime * aDir.z, aLane.z);
          vec3 p = vec3(aLane.x + aDir.x * t, ${STREET_Y.toFixed(1)} + 0.8, aLane.y + aDir.y * t);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float s = 2.2 + 0.004 * -mv.z;
          mv.xy += position.xy * s;
          vUv = uv;
          vCol = aCol;
          vFogDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 fogColor;
        uniform float fogDensity;
        varying vec2 vUv;
        varying vec3 vCol;
        varying float vFogDepth;
        void main() {
          float a = texture2D(uMap, vUv).r;
          float f = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
          gl_FragColor = vec4(vCol * a * (1.0 - f * 0.85), 1.0);
        }`,
    });
    const cars = new THREE.Mesh(inst, this.carMat);
    cars.frustumCulled = false;
    this.group.add(cars);

    // --- street lamps along avenues (static instanced glows)
    const lampGeo = new THREE.OctahedronGeometry(0.7, 0);
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.2, 1.2) });
    const lampCount = lanes.length * 12;
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, lampCount);
    let li = 0;
    for (const l of lanes) {
      for (let s = 0; s < 12; s++) {
        const t = (s / 12) * l.len;
        const side = l.dx !== 0 ? 0 : 1;
        m.makeTranslation(l.ox + l.dx * t + (side ? 4.5 : 0), STREET_Y + 7, l.oz + l.dz * t + (side ? 0 : 4.5));
        lamps.setMatrixAt(li++, m);
      }
    }
    lamps.count = li;
    lamps.frustumCulled = false;
    this.group.add(lamps);

    // --- a few neon signs on neighbours for flavour
    const signs: [string, string, string, number, number, number, number][] = [
      ['HÔTEL', '#ffe9b0', '#ff9a2f', -40, -18, -30, Math.PI / 2],
      ['PIZZA', '#ffd0d0', '#ff3b3b', 34, -30, 30, -Math.PI / 2],
      ['BAR', '#d6fbff', '#21d4ff', 22, -45, -40, 0],
      ['KEBAB', '#fff1c2', '#ffb400', -30, -38, 34, Math.PI],
    ];
    for (const [txt, col, glow, x, y, z, ry] of signs) {
      const tex = textTexture(txt, { color: col, glow, w: 512, h: 160 });
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(14, 4.4),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, color: new THREE.Color(2.2, 2.2, 2.2), fog: true }),
      );
      mesh.position.set(x, y, z);
      mesh.rotation.y = ry;
      this.group.add(mesh);
    }
  }

  update(time: number) {
    this.carMat.uniforms.uTime.value = time;
    this.beaconMat.uniforms.uTime.value = time;
  }
}

/** Gradient dusk sky dome with sun glow, stars and soft clouds. */
export class Sky {
  readonly mesh: THREE.Mesh;
  readonly sunDir = new THREE.Vector3(-34, 21, 14).normalize();
  readonly clouds: THREE.InstancedMesh;
  constructor() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSun: { value: this.sunDir },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSun;
        uniform float uTime;
        varying vec3 vDir;
        float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          float sunAmt = max(dot(d, uSun), 0.0);
          vec3 zenith = vec3(0.10, 0.11, 0.30);
          vec3 mid = vec3(0.42, 0.25, 0.52);
          vec3 horizon = vec3(1.25, 0.55, 0.38);
          vec3 below = vec3(0.30, 0.20, 0.32);
          // horizon warmer toward the sun
          float sunSide = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSun.x, 0.0, uSun.z))), 0.0), 2.0);
          vec3 hz = mix(vec3(0.62, 0.36, 0.56), horizon, 0.35 + 0.65 * sunSide);
          vec3 col = h > 0.0 ? mix(hz, mid, smoothstep(0.0, 0.25, h)) : mix(hz, below, smoothstep(0.0, -0.25, h));
          col = h > 0.0 ? mix(col, zenith, smoothstep(0.2, 0.85, h)) : col;
          // sun disc + glow
          col += vec3(1.6, 0.8, 0.4) * pow(sunAmt, 18.0) * 0.9;
          col += vec3(1.0, 0.45, 0.2) * pow(sunAmt, 4.0) * 0.35;
          col += vec3(18.0, 12.0, 7.0) * smoothstep(0.9993, 0.9997, sunAmt);
          // stars in the upper dark part
          vec3 sp = floor(d * 380.0);
          float s = hash(sp);
          float star = step(0.9965, s) * smoothstep(0.25, 0.7, h) * (0.6 + 0.4 * sin(uTime * 2.0 + s * 50.0));
          col += vec3(star) * 1.4;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 16), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;

    // clouds: billboards near the horizon tinted by sunset
    const tex = softDotTexture();
    const rnd = mulberry(99);
    const n = 16;
    this.clouds = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.45, depthWrite: false, fog: false }),
      n,
    );
    const o = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const dist = 700 + rnd() * 300;
      const towardSun = Math.max(0, Math.cos(a - Math.atan2(this.sunDir.z, this.sunDir.x)));
      const c = new THREE.Color().setRGB(0.9 + towardSun * 0.6, 0.55 + towardSun * 0.25, 0.65).multiplyScalar(0.8 + rnd() * 0.4);
      o.position.set(Math.cos(a) * dist, 40 + rnd() * 120, Math.sin(a) * dist);
      o.lookAt(0, o.position.y, 0);
      o.scale.set(260 + rnd() * 240, 40 + rnd() * 40, 1);
      o.updateMatrix();
      this.clouds.setMatrixAt(i, o.matrix);
      this.clouds.setColorAt(i, c);
    }
    this.clouds.frustumCulled = false;
  }

  update(time: number) {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
  }
}
