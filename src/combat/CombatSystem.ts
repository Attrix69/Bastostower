import * as THREE from 'three';
import { clamp, segmentSegmentDistSq } from '../core/math';
import type { GameContext } from '../game/Context';
import type { Fighter, Hurtbox, IncomingHit } from '../fighters/Fighter';
import { FState } from '../fighters/states';
import type { Prop } from '../props/PropSystem';
import type { CollisionPair } from '../physics/Physics';
import type { Zone } from '../game/events';
import { RP } from '../fighters/Ragdoll';

/**
 * Combat resolution.
 *
 * Strikes are detected by sweeping the real limb position (fist, foot or
 * weapon segment) between two simulation steps and testing the swept volume
 * against the victim's hurtbox capsules (head / torso / limbs). Each attack can
 * hit a given target only once. Props and bodies colliding in the physics
 * world are converted into hits too (thrown objects, human bowling balls,
 * explosions).
 */

const _cur = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _gripA = new THREE.Vector3();
const _tipA = new THREE.Vector3();
const _gripB = new THREE.Vector3();
const _tipB = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _s0 = new THREE.Vector3();
const _s1 = new THREE.Vector3();
const _fwd = new THREE.Vector3();

interface Candidate {
  hb: Hurtbox;
  dist: number;
  point: THREE.Vector3;
}

export class CombatSystem {
  private pairCooldown = new Map<string, number>();

  constructor(private ctx: GameContext) {
    ctx.physics.onCollision((p) => this.onCollision(p));
    // railings give way under heavy impacts (bodies, crates, gas bottles...)
    ctx.physics.onContactForce((p) => {
      const rail = p.oa?.kind === 'railing' ? p.oa : p.ob?.kind === 'railing' ? p.ob : null;
      if (!rail || rail.ref.broken) return;
      const other = rail === p.oa ? p.b : p.a;
      const body = other.parent();
      if (!body || body.isFixed()) return;
      const lv = body.linvel();
      _v.set(lv.x, Math.max(lv.y, 0), lv.z);
      if (_v.lengthSq() < 1e-4) return;
      rail.ref.break(_v.normalize().multiplyScalar(Math.min(p.force * 0.012, 160)));
      const t = rail.ref.body.translation();
      this.ctx.events.emit('railingBreak', { pos: new THREE.Vector3(t.x, t.y, t.z) });
    });
    ctx.events.on('explosion', (e) => this.onExplosion(e.pos, e.radius, e.by));
  }

  update(dt: number) {
    for (const f of this.ctx.fighters) this.processStrikes(f, dt);
  }

  // ------------------------------------------------------------------ strikes
  private processStrikes(f: Fighter, dt: number) {
    const a = f.action;
    if (!a || a.phase !== 'strike') return;
    if (a.button === 'throw' || a.button === 'shove') return;
    const def = a.def;
    const weapon = def.limb === 'weapon' && f.hold?.kind === 'prop';

    if (!a.isActive) {
      a.hasPrev = false;
      return;
    }
    const tPrev = Math.max(0, a.t - dt);
    const segs: [THREE.Vector3, THREE.Vector3][] = [];
    if (weapon) {
      f.weaponSegment(a.t, _gripB, _tipB);
      f.weaponSegment(tPrev, _gripA, _tipA);
      // three sample points along the weapon, each swept from previous to current step
      for (const k of [0.35, 0.7, 1.0]) {
        segs.push([_s0.lerpVectors(_gripA, _tipA, k).clone(), _s1.lerpVectors(_gripB, _tipB, k).clone()]);
      }
    } else {
      f.strikePoint(_cur);
      if (a.hasPrev) _prev.copy(a.prevPoint);
      else f.strikePoint(_prev, tPrev);
      segs.push([_prev.clone(), _cur.clone()]);
      a.prevPoint.copy(_cur);
      a.hasPrev = true;
    }
    const radius = weapon ? 0.13 : def.radius;

    // --- opponent
    const opp = f.opponent;
    if (!a.hit.has(opp) && opp.state !== FState.Falling && opp.heldBy !== f) {
      let best: Candidate | null = null;
      for (const [p0, p1] of segs) {
        for (const hb of opp.hurtboxes) {
          const d2 = segmentSegmentDistSq(p0, p1, hb.a, hb.b, _c1, _c2);
          const rr = radius + hb.r;
          if (d2 < rr * rr) {
            const dist = Math.sqrt(d2) - rr;
            // prefer head hits when several overlap
            const score = dist - (hb.zone === 'head' ? 0.05 : 0);
            if (!best || score < best.dist) best = { hb, dist: score, point: _c2.clone().lerp(_c1, 0.5) };
          }
        }
      }
      if (best) {
        a.hit.add(opp);
        const [p0, p1] = segs[segs.length - 1];
        this.resolveStrike(f, opp, best, p0, p1);
      }
    }

    // --- props in the way get smacked too
    const [p0, p1] = segs[segs.length - 1];
    for (const prop of this.ctx.props.props) {
      if (prop.broken || prop.heldBy || a.hit.has(prop)) continue;
      const pr = prop.radius * 0.85 + radius;
      const d2 = segmentSegmentDistSq(p0, p1, prop.curP, prop.curP, _c1, _c2);
      if (d2 > pr * pr) continue;
      a.hit.add(prop);
      _dir.subVectors(p1, p0);
      if (_dir.lengthSq() < 1e-6) _dir.subVectors(prop.curP, f.pos);
      _dir.normalize();
      _dir.y = Math.max(_dir.y, 0.25);
      const power = weapon ? f.hold!.kind === 'prop' ? (f.hold as { prop: Prop }).prop.def.swing.knockback : 5 : def.knockback;
      const impulse = _v.copy(_dir).multiplyScalar(power * a.power * 1.8 * Math.min(prop.def.mass, 6));
      this.ctx.props.hitProp(prop, impulse, _c1, f);
      this.ctx.events.emit('propImpact', { prop, pos: prop.curP.clone(), speed: 8 });
      this.ctx.loop.hitstop(0.035);
    }
  }

  private resolveStrike(att: Fighter, victim: Fighter, c: Candidate, p0: THREE.Vector3, p1: THREE.Vector3) {
    const a = att.action!;
    const def = a.def;
    const isHeavy = (a.heavy !== null && a.def === a.heavy && a.heavy !== a.quick) || (def.kind === 'swing' && a.charge > 0.45);
    const pw = a.power * att.def.stats.power * (att.exhausted ? 0.6 : 1);
    let damage: number;
    let kb: number;
    let daze: number;
    let lift: number;
    let prop: Prop | undefined;
    if (def.kind === 'swing' && att.hold?.kind === 'prop') {
      prop = att.hold.prop;
      const s = prop.def.swing;
      const ch = 0.75 + a.charge * 0.6;
      damage = s.damage * ch * att.def.stats.power;
      kb = s.knockback * ch;
      daze = s.daze * ch;
      lift = 1 + a.charge * 1.5;
    } else {
      damage = def.damage * pw;
      kb = def.knockback * pw;
      daze = def.daze * pw;
      lift = def.lift * pw;
    }
    // direction: from attacker to victim, bent by the fist's motion (hooks push sideways)
    _dir.set(victim.pos.x - att.pos.x, 0, victim.pos.z - att.pos.z);
    if (_dir.lengthSq() < 1e-6) att.forward(_dir);
    _dir.normalize();
    _v.subVectors(p1, p0);
    _v.y = 0;
    if (_v.lengthSq() > 1e-6) {
      _v.normalize();
      _dir.multiplyScalar(0.72).addScaledVector(_v, 0.28).normalize();
    }
    const zone: Zone = c.hb.zone;
    if (zone === 'head') {
      damage *= 1.3;
      daze *= 1.45;
    }
    // from behind: no block possible, extra pain
    victim.forward(_fwd);
    const behind = _fwd.x * _dir.x + _fwd.z * _dir.z > 0.45;
    if (behind) damage *= 1.25;
    const hit: IncomingHit = {
      attacker: att,
      kind: def.kind === 'swing' ? 'swing' : def.kind === 'kick' ? 'kick' : def.kind === 'shove' ? 'shove' : 'punch',
      damage,
      knockback: kb,
      lift,
      daze,
      dir: _dir.clone(),
      point: c.point,
      zone,
      heavy: isHeavy,
      part: c.hb.part,
      prop,
      unblockable: behind,
      attackName: prop ? prop.def.name : def.name,
    };
    const ev = victim.takeHit(hit);
    if (!ev) {
      // dodged
      return;
    }
    a.connected = true;
    const t = this.ctx.time;
    if (!ev.blocked) {
      att.combo = t - att.lastLanded < 1.1 ? att.combo + 1 : 1;
      att.lastLanded = t;
      att.stats.hits++;
      att.stats.damage += ev.damage;
      att.stats.maxCombo = Math.max(att.stats.maxCombo, att.combo);
    }
    const stop = def.hitstop * (ev.blocked ? 0.6 : 1) * (isHeavy ? 1.35 : 1) * (ev.result === 'ko' ? 1.8 : 1);
    this.ctx.loop.hitstop(clamp(stop, 0.03, 0.2));
    this.ctx.events.emit('hit', ev);
    // a fragile weapon may break on a big hit
    if (prop && isHeavy && prop.def.special === 'break' && prop.def.breakSpeed && prop.def.breakSpeed < 25 && Math.random() < 0.35) {
      this.ctx.props.breakProp(prop);
    }
  }

  // ------------------------------------------------------------------ physics impacts
  private cooldown(key: string, time: number) {
    const t = this.ctx.time;
    const last = this.pairCooldown.get(key) ?? -10;
    if (t - last < time) return false;
    this.pairCooldown.set(key, t);
    return true;
  }

  private onCollision(p: CollisionPair) {
    const { oa, ob } = p;
    if (!oa || !ob) return;
    if (oa.kind === 'prop' && (ob.kind === 'fighter' || ob.kind === 'ragdoll')) this.propHitsFighter(oa.ref, ob.ref, ob.kind === 'ragdoll' ? ob.part : undefined);
    else if (ob.kind === 'prop' && (oa.kind === 'fighter' || oa.kind === 'ragdoll')) this.propHitsFighter(ob.ref, oa.ref, oa.kind === 'ragdoll' ? oa.part : undefined);
    else if (oa.kind === 'ragdoll' && ob.kind === 'fighter') this.bodyHitsFighter(oa.ref, oa.part ?? 0, ob.ref);
    else if (ob.kind === 'ragdoll' && oa.kind === 'fighter') this.bodyHitsFighter(ob.ref, ob.part ?? 0, oa.ref);
    else if (oa.kind === 'ragdoll' && (ob.kind === 'static' || ob.kind === 'railing')) this.bodySlam(oa.ref, oa.part ?? 0, ob.kind === 'railing' ? ob.ref : null);
    else if (ob.kind === 'ragdoll' && (oa.kind === 'static' || oa.kind === 'railing')) this.bodySlam(ob.ref, ob.part ?? 0, oa.kind === 'railing' ? oa.ref : null);
  }

  private propHitsFighter(prop: Prop, victim: Fighter, part?: number) {
    if (prop.heldBy || prop.broken) return;
    const t = this.ctx.time;
    // relative speed using the prop's pre-impact velocity
    if (part !== undefined) _v.copy(victim.ragdoll.parts[part].prevVel);
    else _v.copy(victim.vel).add(victim.kb);
    const rel = prop.impactVel(_dir).sub(_v);
    const speed = rel.length();
    if (speed < 3.4) return;
    if (t - (prop.lastHit.get(victim) ?? -10) < 0.5) return;
    prop.lastHit.set(victim, t);
    const by = prop.thrownBy && t - prop.thrownTime < 3.5 && prop.thrownBy !== victim ? prop.thrownBy : null;
    const def = prop.def;
    const J = def.mass * speed;
    let damage = clamp(J * 0.3 * def.throwDamage, 2, 28);
    let kb = clamp(J * 0.13, 1.5, 15);
    if (def.special === 'float') {
      damage = 0.5;
      kb = 9;
    }
    const daze = clamp(J * 0.65 * def.dazeMul, 4, 70);
    rel.y = 0;
    if (rel.lengthSq() < 1e-6) rel.set(victim.pos.x - prop.curP.x, 0, victim.pos.z - prop.curP.z);
    rel.normalize();
    let zone: Zone = 'torso';
    if (part !== undefined) zone = part === RP.head ? 'head' : part >= RP.thighL ? 'legs' : 'torso';
    else {
      const h = prop.curP.y - victim.pos.y;
      zone = h > victim.eyeHeight - 0.25 ? 'head' : h < 0.75 ? 'legs' : 'torso';
    }
    const ev = victim.takeHit({
      attacker: by,
      kind: 'prop',
      damage,
      knockback: kb,
      lift: 1 + Math.min(J * 0.02, 2.5),
      daze,
      dir: rel.clone(),
      point: prop.curP.clone(),
      zone,
      heavy: J > 24,
      part,
      prop,
      attackName: def.name,
    });
    if (!ev) return;
    if (by && !ev.blocked) {
      by.stats.hits++;
      by.stats.damage += ev.damage;
    }
    if (J > 10) this.ctx.loop.hitstop(clamp(J * 0.0025, 0.03, 0.11));
    this.ctx.events.emit('hit', ev);
  }

  /** A flying body crashing into the other fighter: human bowling. */
  private bodyHitsFighter(flying: Fighter, part: number, target: Fighter) {
    if (flying === target) return;
    if (!(flying.state === FState.Thrown || flying.state === FState.KO || flying.state === FState.Falling)) return;
    const pv = flying.ragdoll.impactVel(part, _s0);
    const speed = pv.length();
    if (speed < 5.5) return;
    if (!this.cooldown(`body${flying.index}`, 0.8)) return;
    const by = flying.lastAttacker?.by ?? null;
    _dir.copy(pv);
    _dir.y = 0;
    _dir.normalize();
    const ev = target.takeHit({
      attacker: by === target ? null : by,
      kind: 'body',
      damage: speed * 1.4,
      knockback: speed * 0.9,
      lift: 2.5,
      daze: 30,
      dir: _dir.clone(),
      point: flying.ragdoll.parts[part].curP.clone(),
      zone: 'torso',
      heavy: true,
      attackName: 'Boulet humain',
    });
    if (ev) {
      this.ctx.events.emit('hit', ev);
      this.ctx.loop.hitstop(0.08);
    }
  }

  /** Ragdoll slamming into the floor / a wall. */
  private bodySlam(f: Fighter, part: number, railing: { broken: boolean; break: (v: THREE.Vector3) => void } | null) {
    const pv = f.ragdoll.impactVel(part, _s1);
    const speed = pv.length();
    if (railing && !railing.broken && speed > 5) {
      railing.break(_v.copy(pv).multiplyScalar(f.massMul * 20));
      this.ctx.events.emit('railingBreak', { pos: f.ragdoll.parts[part].curP.clone() });
    }
    if (speed < 6) return;
    if (!this.cooldown(`slam${f.index}`, 0.25)) return;
    const dmg = (speed - 6) * 1.8;
    if (f.state !== FState.Falling) f.health = Math.max(0, f.health - dmg);
    this.ctx.events.emit('bodyImpact', { fighter: f, pos: f.ragdoll.parts[part].curP.clone(), speed, part });
  }

  // ------------------------------------------------------------------ explosions
  private onExplosion(pos: THREE.Vector3, radius: number, by: Fighter | null) {
    for (const f of this.ctx.fighters) {
      if (f.state === FState.Falling) continue;
      _v.set(f.pos.x, f.pos.y + 0.9, f.pos.z);
      const d = _v.distanceTo(pos);
      if (d > radius) continue;
      const k = 1 - d / radius;
      _dir.set(f.pos.x - pos.x, 0, f.pos.z - pos.z);
      if (_dir.lengthSq() < 1e-4) _dir.set(1, 0, 0);
      _dir.normalize();
      const ev = f.takeHit({
        attacker: by === f ? null : by,
        kind: 'explosion',
        damage: 8 + 30 * k,
        knockback: 5 + 14 * k,
        lift: 3 + 7 * k,
        daze: 70 * k,
        dir: _dir.clone(),
        point: pos.clone(),
        zone: 'torso',
        heavy: true,
        unblockable: true,
        attackName: 'Explosion',
      });
      if (ev) this.ctx.events.emit('hit', ev);
    }
    this.ctx.loop.hitstop(0.1);
  }
}

