import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, HitEvent } from '../game/events';
import type { Fighter } from '../fighters/Fighter';
import { FState } from '../fighters/states';
import { chance, pick, rand } from '../core/math';
import { ChunkParticles, Decals, Sprite, SpriteParticles } from './Particles';
import { comicAtlas, COMIC_WORDS, speechBubbleTexture } from '../world/textures';
import { ROOF } from '../world/Arena';
import { B } from '../fighters/Rig';

/**
 * Effects director: listens to gameplay events and spawns the matching visual
 * feedback (impact flashes, stylized blood, teeth, sweat, debris, comic words,
 * explosions, speech bubbles). Every effect scales with impact power and is
 * kept short-lived so it never hurts readability.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const BLOOD = 0xd8102a;
const BLOOD_DARK = 0x9a0a1e;
const CONFETTI = [0xff4f8b, 0xffd23f, 0x3fd2ff, 0x7dff6a, 0xb87dff];

interface ComicSprite {
  sprite: THREE.Sprite;
  life: number;
  max: number;
  base: number;
}

interface Bubble {
  sprite: THREE.Sprite;
  life: number;
  fighter: Fighter;
}

export class FX {
  readonly group = new THREE.Group();
  readonly chunks: ChunkParticles;
  readonly drops: ChunkParticles;
  readonly additive: SpriteParticles;
  readonly alpha: SpriteParticles;
  readonly decals: Decals;
  private comics: ComicSprite[] = [];
  private comicIdx = 0;
  private bubbles = new Map<Fighter, Bubble>();
  private flashLight: THREE.PointLight;
  private flashT = 0;
  budget = 1;
  /** 'blood' or 'confetti' (family friendly) */
  gore: 'blood' | 'confetti' = 'blood';
  /** camera position (for screen-size aware effects) */
  private camPos = new THREE.Vector3(0, 100, 0);
  /** screen feedback hooks (camera & post FX) */
  onScreenFlash: ((color: THREE.ColorRepresentation, strength: number) => void) | null = null;

  constructor(events: EventBus<GameEvents>, private fighters: () => Fighter[]) {
    const chunkMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 });
    this.chunks = new ChunkParticles(new THREE.BoxGeometry(1, 1, 1), 500, chunkMat);
    const dropMat = new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0, emissive: 0x220000 });
    this.drops = new ChunkParticles(new THREE.IcosahedronGeometry(0.5, 1), 700, dropMat);
    this.additive = new SpriteParticles(500, true);
    this.alpha = new SpriteParticles(400, false);
    this.decals = new Decals(96);
    const floor = (x: number, z: number) => (x > ROOF.minX && x < ROOF.maxX && z > ROOF.minZ && z < ROOF.maxZ ? 0 : x > ROOF.maxX && x < ROOF.maxX + 3.4 && Math.abs(z) < 0.37 ? 0.1 : null);
    this.drops.floorAt = floor;
    this.chunks.floorAt = (x, z) => floor(x, z) ?? -120;
    this.drops.onSplat = (x, y, z, size, r, g, b) => this.decals.add(x, y, z, size, new THREE.Color(r, g, b).multiplyScalar(0.85));
    this.group.add(this.chunks.mesh, this.drops.mesh, this.additive.mesh, this.alpha.mesh, this.decals.mesh);

    // comic onomatopoeia sprites
    const atlas = comicAtlas();
    for (let i = 0; i < 8; i++) {
      const tex = atlas.clone();
      tex.needsUpdate = true;
      tex.repeat.set(0.5, 0.25);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.renderOrder = 20;
      this.group.add(s);
      this.comics.push({ sprite: s, life: 0, max: 1, base: 1 });
    }

    this.flashLight = new THREE.PointLight(0xffa040, 0, 18, 1.5);
    this.group.add(this.flashLight);

    events.on('hit', (e) => this.onHit(e));
    events.on('parry', (e) => {
      this.ring(e.point, 0xffffff, 1.2, 0.25);
      this.sparks(e.point, 14, 0xfff3b0, 7);
      this.onScreenFlash?.(0xffffff, 0.25);
    });
    events.on('land', (e) => this.dust(e.pos, Math.min(1.5, e.speed / 8)));
    events.on('bodyImpact', (e) => {
      this.dust(e.pos, Math.min(2, e.speed / 7));
      if (e.speed > 9) this.blood(e.pos, _v.set(0, 1, 0), Math.min(1.2, e.speed / 14));
    });
    events.on('footstep', (e) => {
      if (e.intensity > 0.9 && chance(0.4)) this.dust(e.pos, 0.3);
    });
    events.on('propBreak', (e) => this.breakFx(e.prop.def.id, e.prop.def.special, e.prop.def.debrisColor, e.pos));
    events.on('explosion', (e) => this.explosion(e.pos, e.radius));
    events.on('railingBreak', (e) => this.sparks(e.pos, 20, 0xffd080, 8));
    events.on('stateChange', (e) => {
      if (e.to === FState.Stunned) this.stunBurst(e.fighter);
      if (e.to === FState.KO) this.koBurst(e.fighter);
    });
    events.on('dodge', (e) => this.dust(e.fighter.pos, 0.35));
    events.on('taunt', (e) => this.say(e.fighter, e.text));
    events.on('grab', (e) => this.dust(e.victim.pos, 0.5));
    events.on('throwBody', (e) => {
      e.victim.ragdoll.pelvisPos(_v);
      this.ring(_v, 0xffffff, 1.0, 0.3);
    });
  }

  reset() {
    this.chunks.clear();
    this.drops.clear();
    this.additive.clear();
    this.alpha.clear();
    this.decals.clear();
    for (const c of this.comics) c.sprite.visible = false;
    for (const b of this.bubbles.values()) b.sprite.visible = false;
  }

  // ------------------------------------------------------------------ primitives
  flash(pos: THREE.Vector3, color: THREE.ColorRepresentation, size: number, life = 0.12) {
    // never let an impact flash swallow the screen when it happens right in your face
    size = Math.min(size, pos.distanceTo(this.camPos) * 0.32);
    this.additive.emit({ pos, cell: Sprite.Burst, color, size: size * 0.6, endSize: size, life, intensity: 2.2, rotSpeed: 4 });
    this.additive.emit({ pos, cell: Sprite.Dot, color, size: size * 1.4, endSize: size * 0.4, life: life * 0.8, intensity: 1.5 });
  }

  ring(pos: THREE.Vector3, color: THREE.ColorRepresentation, size: number, life = 0.22) {
    size = Math.min(size, pos.distanceTo(this.camPos) * 0.45);
    this.additive.emit({ pos, cell: Sprite.Ring, color, size: size * 0.2, endSize: size, life, intensity: 1.8 });
  }

  sparks(pos: THREE.Vector3, n: number, color: THREE.ColorRepresentation, speed: number) {
    n = Math.ceil(n * this.budget);
    for (let i = 0; i < n; i++) {
      _v.set(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).normalize().multiplyScalar(speed * rand(0.4, 1));
      this.additive.emit({ pos, vel: _v, cell: Sprite.Streak, color, size: rand(0.08, 0.18), endSize: 0.02, life: rand(0.15, 0.35), intensity: 2.5, gravity: 9, drag: 2, rot: Math.atan2(_v.y, _v.x) });
    }
  }

  dust(pos: THREE.Vector3, k: number) {
    const n = Math.ceil((4 + k * 6) * this.budget);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      _v.set(Math.cos(a), 0.15, Math.sin(a)).multiplyScalar(rand(0.6, 1.8) * (0.6 + k));
      _v2.set(pos.x + Math.cos(a) * 0.15, pos.y + 0.08, pos.z + Math.sin(a) * 0.15);
      this.alpha.emit({ pos: _v2, vel: _v, cell: Sprite.Smoke, color: 0xcbbfb4, alpha: 0.5, size: 0.25 + k * 0.15, endSize: 0.6 + k * 0.5, life: rand(0.5, 0.9), drag: 3, gravity: -0.3 });
    }
  }

  blood(pos: THREE.Vector3, dir: THREE.Vector3, power: number) {
    const conf = this.gore === 'confetti';
    const n = Math.ceil((5 + power * 14) * this.budget);
    for (let i = 0; i < n; i++) {
      _v.copy(dir).multiplyScalar(rand(1.5, 4.5) * (0.6 + power));
      _v.x += rand(-1.6, 1.6);
      _v.y += rand(0.5, 3.2);
      _v.z += rand(-1.6, 1.6);
      this.drops.emit({
        pos,
        vel: _v,
        color: conf ? pick(CONFETTI) : chance(0.7) ? BLOOD : BLOOD_DARK,
        size: conf ? rand(0.03, 0.05) : rand(0.018, 0.042) * (0.8 + power * 0.35),
        life: rand(0.8, 1.6),
        gravity: conf ? 4 : 14,
        drag: conf ? 3 : 0.5,
        stretch: !conf,
        splat: conf ? 0 : chance(0.5) ? rand(0.12, 0.3) * (0.7 + power * 0.5) : 0,
        spin: conf ? 14 : 0,
      });
    }
    // a little mist
    if (!conf) {
      this.alpha.emit({ pos, vel: _v.copy(dir).multiplyScalar(1.2), cell: Sprite.Smoke, color: BLOOD, alpha: 0.55, size: 0.12, endSize: 0.35 + power * 0.2, life: 0.35, drag: 4 });
    }
  }

  teeth(pos: THREE.Vector3, dir: THREE.Vector3, n: number) {
    for (let i = 0; i < n; i++) {
      _v.copy(dir).multiplyScalar(rand(2, 4));
      _v.y += rand(2, 4.5);
      _v.x += rand(-1, 1);
      _v.z += rand(-1, 1);
      this.chunks.emit({ pos, vel: _v, color: 0xfdfbf2, size: rand(0.025, 0.035), life: rand(2.5, 4), gravity: 14, drag: 0.3, bounce: 0.45, spin: 18 });
    }
  }

  debris(pos: THREE.Vector3, color: THREE.ColorRepresentation, n: number, speed: number, size = 0.07) {
    n = Math.ceil(n * this.budget);
    for (let i = 0; i < n; i++) {
      _v.set(rand(-1, 1), rand(0.2, 1.4), rand(-1, 1)).normalize().multiplyScalar(speed * rand(0.4, 1.1));
      this.chunks.emit({ pos, vel: _v, color, size: size * rand(0.5, 1.4), life: rand(1.2, 2.5), gravity: 14, drag: 0.3, bounce: 0.35, spin: 12 });
    }
  }

  comic(pos: THREE.Vector3, word: number, scale: number) {
    const c = this.comics[this.comicIdx];
    this.comicIdx = (this.comicIdx + 1) % this.comics.length;
    const tex = (c.sprite.material as THREE.SpriteMaterial).map!;
    const col = word % 2;
    const row = Math.floor(word / 2);
    tex.offset.set(col * 0.5, 1 - (row + 1) * 0.25);
    c.sprite.visible = true;
    c.sprite.position.copy(pos);
    c.sprite.position.y += 0.35;
    // keep words readable but never screen-filling: push them away from the camera if needed
    const d = c.sprite.position.distanceTo(this.camPos);
    if (d < 2.2) {
      _v.subVectors(c.sprite.position, this.camPos).normalize();
      c.sprite.position.copy(this.camPos).addScaledVector(_v, 2.2);
      c.sprite.position.y += 0.25;
    }
    scale = Math.min(scale, 0.18 * Math.max(d, 2.2));
    c.life = 0.7;
    c.max = 0.7;
    c.base = scale;
    (c.sprite.material as THREE.SpriteMaterial).rotation = rand(-0.25, 0.25);
    (c.sprite.material as THREE.SpriteMaterial).opacity = 1;
  }

  say(f: Fighter, text: string) {
    let b = this.bubbles.get(f);
    if (!b) {
      const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.renderOrder = 19;
      this.group.add(sprite);
      b = { sprite, life: 0, fighter: f };
      this.bubbles.set(f, b);
    }
    const mat = b.sprite.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.map = speechBubbleTexture(text);
    mat.needsUpdate = true;
    b.sprite.scale.set(1.6, 0.6, 1);
    b.life = 2.6;
    b.sprite.visible = true;
  }

  // ------------------------------------------------------------------ composite effects
  private onHit(e: HitEvent) {
    const p = e.point;
    const pw = e.power;
    _v2.copy(e.dir);
    if (e.blocked) {
      this.sparks(p, e.perfect ? 16 : 8, 0xfff0c0, 4 + pw * 3);
      this.ring(p, 0xbfe8ff, 0.5 + pw * 0.4, 0.18);
      return;
    }
    const heavy = e.heavy || pw > 1.1;
    this.flash(p, heavy ? 0xfff0c8 : 0xffffff, 0.35 + pw * 0.45, heavy ? 0.16 : 0.1);
    if (heavy) this.ring(p, 0xffffff, 0.8 + pw * 0.6, 0.22);
    if (e.kind !== 'explosion') {
      const bloodPower = pw * (e.zone === 'head' ? 1.4 : 1) * (e.prop?.def.special === 'float' ? 0 : 1);
      if (bloodPower > 0.15) this.blood(p, _v2, bloodPower);
      // sweat
      for (let i = 0; i < 3 + pw * 3; i++) {
        _v.copy(_v2).multiplyScalar(rand(1, 3));
        _v.y += rand(1, 3);
        this.additive.emit({ pos: p, vel: _v, cell: Sprite.Drop, color: 0x9fe4ff, size: 0.06, endSize: 0.04, life: 0.5, gravity: 10, intensity: 1.2 });
      }
      if (e.zone === 'head' && heavy && chance(0.45)) this.teeth(p, _v2, 1 + Math.floor(Math.random() * 3));
    }
    if (e.kind === 'kick') this.dust(_v.set(e.victim.pos.x, e.victim.pos.y, e.victim.pos.z), 0.6);
    if (heavy || chance(0.18)) {
      let word = Math.floor(Math.random() * COMIC_WORDS.length);
      if (e.prop?.def.sound === 'pan') word = COMIC_WORDS.indexOf('BOING!');
      else if (word === COMIC_WORDS.indexOf('BOING!')) word = 0;
      this.comic(p, word, 0.45 + pw * 0.25);
    }
    if (heavy) this.onScreenFlash?.(0xffffff, 0.12 + pw * 0.06);
  }

  private stunBurst(f: Fighter) {
    _v.setFromMatrixPosition(f.rig.bones[B.head].matrixWorld);
    _v.y += 0.3;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      _v2.set(Math.cos(a) * 2, rand(0.5, 2), Math.sin(a) * 2);
      this.additive.emit({ pos: _v, vel: _v2, cell: Sprite.Star, color: 0xffe14d, size: 0.16, endSize: 0.05, life: 0.7, drag: 3, intensity: 2, rotSpeed: 6 });
    }
    this.additive.emit({ pos: _v, cell: Sprite.Swirl, color: 0xffffff, size: 0.2, endSize: 0.7, life: 0.5, intensity: 1.5, rotSpeed: 10 });
  }

  private koBurst(f: Fighter) {
    f.ragdoll.active ? _v.copy(f.ragdoll.parts[2].curP) : _v.setFromMatrixPosition(f.rig.bones[B.head].matrixWorld);
    for (let i = 0; i < 16; i++) {
      _v2.set(rand(-1, 1), rand(0.3, 1.5), rand(-1, 1)).multiplyScalar(3);
      this.additive.emit({ pos: _v, vel: _v2, cell: Sprite.Star, color: pick([0xffe14d, 0xffffff, 0xff9ad5]), size: 0.2, endSize: 0.04, life: 0.9, drag: 2.5, gravity: 2, intensity: 2.2, rotSpeed: 8 });
    }
  }

  private breakFx(id: string, special: string | undefined, color: number, pos: THREE.Vector3) {
    if (special === 'splat') {
      const conf = this.gore === 'confetti';
      for (let i = 0; i < 26 * this.budget; i++) {
        _v.set(rand(-1, 1), rand(0.4, 1.6), rand(-1, 1)).multiplyScalar(rand(2, 5));
        this.drops.emit({ pos, vel: _v, color: conf ? pick(CONFETTI) : chance(0.75) ? 0xff2a4a : 0xff6f8a, size: rand(0.03, 0.07), life: rand(0.8, 1.5), gravity: 13, stretch: true, splat: chance(0.6) ? rand(0.18, 0.35) : 0 });
      }
      this.debris(pos, 0x2f8a2c, 10, 4, 0.08);
      this.debris(pos, 0x111111, 8, 3, 0.02);
      this.alpha.emit({ pos, cell: Sprite.Smoke, color: 0xff3355, alpha: 0.6, size: 0.3, endSize: 1.2, life: 0.4 });
      this.comic(pos, COMIC_WORDS.indexOf('SBAFF!'), 0.6);
      return;
    }
    if (special === 'crumble') {
      this.debris(pos, color, 22, 3, 0.04);
      this.dust(pos, 0.5);
      return;
    }
    const big = id === 'crate' || id === 'cinder';
    this.debris(pos, color, big ? 22 : 16, big ? 5 : 4, big ? 0.1 : 0.06);
    if (id === 'gnome') {
      this.debris(pos, 0x2f7fd8, 8, 4, 0.05);
      this.debris(pos, 0xffffff, 8, 4, 0.05);
    }
    this.dust(pos, 0.8);
    this.comic(pos, COMIC_WORDS.indexOf('CRAC!'), 0.55);
  }

  explosion(pos: THREE.Vector3, radius: number) {
    this.additive.emit({ pos, cell: Sprite.Dot, color: 0xfff2c0, size: 1, endSize: radius * 1.6, life: 0.25, intensity: 4 });
    this.ring(pos, 0xffc070, radius * 1.4, 0.35);
    for (let i = 0; i < 26 * this.budget; i++) {
      _v.set(rand(-1, 1), rand(-0.1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(2, 7));
      this.additive.emit({ pos, vel: _v, cell: Sprite.Smoke, color: pick([0xff8a2a, 0xffc04a, 0xff5a1a]), size: 0.5, endSize: rand(1.2, 2.2), life: rand(0.35, 0.7), drag: 4, intensity: 2.6, gravity: -2 });
    }
    for (let i = 0; i < 22 * this.budget; i++) {
      _v.set(rand(-1, 1), rand(0.2, 1), rand(-1, 1)).normalize().multiplyScalar(rand(1, 4));
      this.alpha.emit({ pos, vel: _v, cell: Sprite.Smoke, color: 0x2a2626, alpha: 0.75, size: 0.8, endSize: rand(2, 3.4), life: rand(1.4, 2.6), drag: 1.8, gravity: -1.5 });
    }
    this.sparks(pos, 30, 0xffd27a, 14);
    this.debris(pos, 0xd8322a, 14, 9, 0.08);
    this.debris(pos, 0x333333, 10, 8, 0.06);
    this.decals.add(pos.x, 0, pos.z, radius * 0.8, 0x1a1414, 40, 0.8);
    this.flashLight.position.copy(pos);
    this.flashLight.position.y += 0.8;
    this.flashT = 0.6;
    this.comic(pos, COMIC_WORDS.indexOf('BAM!'), 1.4);
    this.onScreenFlash?.(0xffd0a0, 0.6);
  }

  // ------------------------------------------------------------------ update
  update(dt: number, camera: THREE.Camera) {
    camera.getWorldPosition(this.camPos);
    this.chunks.update(dt);
    this.drops.update(dt);
    this.additive.update(dt);
    this.alpha.update(dt);
    this.decals.update(dt);
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flashLight.intensity = Math.max(0, this.flashT / 0.6) * 140;
    } else this.flashLight.intensity = 0;
    for (const c of this.comics) {
      if (!c.sprite.visible) continue;
      c.life -= dt;
      if (c.life <= 0) {
        c.sprite.visible = false;
        continue;
      }
      const t = 1 - c.life / c.max;
      const pop = t < 0.15 ? 0.4 + (t / 0.15) * 0.8 : t < 0.25 ? 1.2 - ((t - 0.15) / 0.1) * 0.2 : 1;
      const s = c.base * pop;
      c.sprite.scale.set(s * 2, s, 1);
      c.sprite.position.y += dt * 0.4;
      (c.sprite.material as THREE.SpriteMaterial).opacity = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
    }
    for (const b of this.bubbles.values()) {
      if (!b.sprite.visible) continue;
      b.life -= dt;
      if (b.life <= 0 || b.fighter.state === FState.Falling) {
        b.sprite.visible = false;
        continue;
      }
      const f = b.fighter;
      if (f.ragdoll.active) _v.copy(f.ragdoll.parts[2].curP);
      else _v.setFromMatrixPosition(f.rig.bones[B.head].matrixWorld);
      b.sprite.position.set(_v.x, _v.y + 0.75, _v.z);
      const dist = camera.position.distanceTo(b.sprite.position);
      const s = Math.max(1, dist * 0.18);
      b.sprite.scale.set(1.6 * s * 0.6, 0.6 * s * 0.6, 1);
      (b.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, b.life * 3);
      // the player's own bubble is never shown in first person
      b.sprite.visible = !f.isPlayer || f.isDown;
    }
    void this.fighters;
  }
}
