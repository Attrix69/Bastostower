import * as THREE from 'three';
import type { GameContext } from '../game/Context';
import { walkable, type Fighter } from '../fighters/Fighter';
import type { ActionInstance } from '../fighters/attacks';
import { FState, RULES } from '../fighters/states';
import type { InteractionSystem } from '../interaction/InteractionSystem';
import type { Prop } from '../props/PropSystem';
import { chance, clamp, forwardFromYaw, pick, rand, rightFromYaw, wrapAngle, yawFromDir } from '../core/math';
import { ROOF } from '../world/Arena';

/**
 * Opponent brain. Writes the same Intent a human would (no cheating on
 * physics): steering with context-based obstacle & void avoidance, reaction
 * delays, combos via button "macros", edge-aware positioning (it tries to put
 * YOU between itself and the void), prop usage and the grab → carry → throw
 * routine.
 */

export type Difficulty = 'easy' | 'normal' | 'hard';

interface Params {
  reaction: number;
  blockChance: number;
  dodgeChance: number;
  aggression: number;
  aimError: number;
  mashRate: number;
  heavyChance: number;
  propChance: number;
  grabDesire: number;
  turnRate: number;
}

export const DIFFICULTY: Record<Difficulty, Params> = {
  easy: { reaction: 0.42, blockChance: 0.15, dodgeChance: 0.05, aggression: 0.45, aimError: 0.3, mashRate: 3.2, heavyChance: 0.15, propChance: 0.25, grabDesire: 0.55, turnRate: 5 },
  normal: { reaction: 0.26, blockChance: 0.36, dodgeChance: 0.12, aggression: 0.7, aimError: 0.15, mashRate: 5.2, heavyChance: 0.3, propChance: 0.4, grabDesire: 0.85, turnRate: 8 },
  hard: { reaction: 0.15, blockChance: 0.58, dodgeChance: 0.2, aggression: 0.9, aimError: 0.06, mashRate: 7.5, heavyChance: 0.4, propChance: 0.5, grabDesire: 1, turnRate: 11 },
};

type Goal = 'approach' | 'fight' | 'circle' | 'retreat' | 'getProp' | 'useProp' | 'grab' | 'carry' | 'stomp' | 'escape' | 'idle';
type MacroBtn = 'punchL' | 'punchR' | 'kick' | 'interact' | 'dodge' | 'wait';

interface MacroStep {
  btn: MacroBtn;
  hold: number;
  after: number;
}

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const DIRS: [number, number][] = Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)];
});

export class AIController {
  params: Params;
  private goal: Goal = 'approach';
  private goalTime = 0;
  private think = 0;
  private macro: MacroStep[] = [];
  private macroT = 0;
  private blockT = 0;
  private attackCd = 1;
  private strafeDir = 1;
  private strafeT = 0;
  private reactT = -1;
  private reactKind: 'block' | 'dodge' | null = null;
  private seenAction: ActionInstance | null = null;
  private seenProps = new Set<Prop>();
  private targetProp: Prop | null = null;
  private throwSpot: { x: number; z: number; nx: number; nz: number } | null = null;
  private mashAcc = 0;
  private tauntCd = 5;
  private yawTarget = 0;
  private pitchTarget = 0;
  private circleT = 0;
  private aimNoise = 0;

  constructor(
    private ctx: GameContext,
    readonly fighter: Fighter,
    private interaction: InteractionSystem,
    difficulty: Difficulty,
  ) {
    this.params = DIFFICULTY[difficulty];
    ctx.events.on('hit', (e) => {
      if (e.victim === fighter && e.damage > 10 && chance(0.35)) this.say(pick(fighter.def.hurtLines), 3);
      if (e.attacker === fighter && (e.result === 'ko' || e.result === 'stun') && chance(0.6)) this.say(pick(fighter.def.taunts), 4);
    });
  }

  setDifficulty(d: Difficulty) {
    this.params = DIFFICULTY[d];
  }

  reset() {
    this.goal = 'approach';
    this.macro = [];
    this.blockT = 0;
    this.attackCd = 1.2;
    this.targetProp = null;
    this.throwSpot = null;
    this.seenProps.clear();
    this.seenAction = null;
    this.tauntCd = 3;
    this.yawTarget = this.fighter.yaw;
  }

  say(text: string, cooldown = 6) {
    if (this.tauntCd > 0 || !text) return;
    this.tauntCd = cooldown;
    this.ctx.events.emit('taunt', { fighter: this.fighter, text });
  }

  private setGoal(g: Goal) {
    if (g !== this.goal) {
      this.goal = g;
      this.goalTime = 0;
      if (g !== 'fight' && g !== 'useProp') this.macro = [];
    }
  }

  update(dt: number) {
    const f = this.fighter;
    const it = f.intent;
    it.clearEdges();
    it.moveX = 0;
    it.moveZ = 0;
    it.sprint = false;
    it.block = false;
    this.goalTime += dt;
    this.tauntCd -= dt;
    this.attackCd -= dt;
    if (!this.ctx.live) {
      it.reset();
      it.yaw = f.yaw;
      return;
    }
    const opp = f.opponent;

    // ---------------- held by the opponent: mash to escape
    if (f.heldBy) {
      this.setGoal('escape');
      this.mashAcc += this.params.mashRate * dt * rand(0.6, 1.4);
      while (this.mashAcc >= 1) {
        this.mashAcc -= 1;
        it.mash++;
      }
      return;
    }
    if (RULES[f.state].ragdoll || f.state === FState.GettingUp) {
      this.macro = [];
      this.blockT = 0;
      return;
    }

    // ---------------- decide
    this.think -= dt;
    if (this.think <= 0) {
      this.think = rand(0.12, 0.22);
      this.decide();
    }
    this.perceive(dt);

    // ---------------- act
    switch (this.goal) {
      case 'approach':
        this.faceTarget(opp.pos);
        this.steer(opp.pos.x, opp.pos.z, 1.05, false);
        it.sprint = this.dist() > 5;
        break;
      case 'fight':
        this.doFight(dt);
        break;
      case 'circle':
        this.doCircle(dt);
        break;
      case 'retreat':
        this.doRetreat();
        break;
      case 'getProp':
        this.doGetProp();
        break;
      case 'useProp':
        this.doUseProp(dt);
        break;
      case 'grab':
      case 'stomp':
        this.doGrabOrStomp();
        break;
      case 'carry':
        this.doCarry(dt);
        break;
      default:
        break;
    }

    // ---------------- defensive reactions override
    if (this.blockT > 0) {
      this.blockT -= dt;
      it.block = true;
    }
    this.runMacro(dt);
    // turning
    const maxTurn = this.params.turnRate * dt;
    const dy = wrapAngle(this.yawTarget - f.yaw);
    it.yaw = wrapAngle(f.yaw + clamp(dy, -maxTurn, maxTurn));
    it.pitch += (this.pitchTarget - it.pitch) * Math.min(1, dt * 10);
  }

  // ------------------------------------------------------------------ perception
  private dist() {
    const o = this.fighter.opponent;
    return Math.hypot(o.pos.x - this.fighter.pos.x, o.pos.z - this.fighter.pos.z);
  }

  private perceive(dt: number) {
    const f = this.fighter;
    const opp = f.opponent;
    const p = this.params;
    // incoming melee
    const pa = opp.action;
    if (pa && pa !== this.seenAction && this.dist() < 2.6 && pa.button !== 'throw') {
      this.seenAction = pa;
      if (this.reactT < 0) {
        const r = Math.random();
        if (r < p.blockChance) this.reactKind = 'block';
        else if (r < p.blockChance + p.dodgeChance) this.reactKind = 'dodge';
        else this.reactKind = null;
        if (this.reactKind) this.reactT = p.reaction * rand(0.7, 1.3);
      }
    }
    // incoming props
    for (const prop of this.ctx.props.props) {
      if (prop.thrownBy !== opp || this.seenProps.has(prop) || this.ctx.time - prop.thrownTime > 1.2) continue;
      _v.subVectors(f.pos, prop.curP);
      const d = _v.length();
      if (d > 8 || prop.prevVel.dot(_v) < 0) continue;
      this.seenProps.add(prop);
      if (Math.random() < p.blockChance + p.dodgeChance) {
        this.reactKind = Math.random() < 0.5 ? 'dodge' : 'block';
        this.reactT = p.reaction * 0.8;
      }
    }
    if (this.reactT >= 0) {
      this.reactT -= dt;
      if (this.reactT < 0 && this.reactKind) {
        if (this.reactKind === 'block' && f.hold?.kind !== 'fighter') {
          this.blockT = rand(0.35, 0.75);
          this.macro = [];
        } else if (this.reactKind === 'dodge') {
          // sidestep (or back off) without jumping into the void
          const side = chance(0.5) ? 1 : -1;
          this.macro = [{ btn: 'dodge', hold: 0.02, after: 0.25 }];
          this.dodgeSide = side;
        }
        this.reactKind = null;
      }
    }
  }
  private dodgeSide = 1;

  private decide() {
    const f = this.fighter;
    const opp = f.opponent;
    const p = this.params;
    const d = this.dist();
    const arena = this.ctx.arena;

    if (f.hold?.kind === 'fighter') return this.setGoal('carry');

    // a vulnerable opponent is the priority: kick him off if he's near the void, else grab him
    const oppDown = opp.isDown && opp.state !== FState.Falling;
    const grabbable = RULES[opp.state].grabbable && !opp.heldBy;
    if (oppDown && grabbable) {
      opp.ragdoll.pelvisPos(_v);
      const edge = arena.distanceToOpenEdge(_v.x, _v.z);
      if (edge < 2.3) return this.setGoal('stomp');
      if (Math.random() < p.grabDesire || this.goal === 'grab') return this.goGrab();
      if (chance(0.3)) this.say(pick(f.def.taunts), 5);
      return this.setGoal(f.hold ? 'useProp' : 'circle');
    }
    if (opp.state === FState.Stunned && grabbable) {
      if (this.goal === 'grab' || Math.random() < p.grabDesire * 0.7) return this.goGrab();
      return this.setGoal(f.hold ? 'useProp' : d > 1.8 ? 'approach' : 'fight');
    }
    if (f.hold?.kind === 'prop') return this.setGoal('useProp');
    if ((f.stamina < 22 || f.exhausted) && this.goal !== 'retreat') return this.setGoal('retreat');
    if (this.goal === 'retreat' && f.stamina < 60) return;
    if (this.goal === 'getProp' && this.targetProp && !this.targetProp.heldBy && !this.targetProp.broken && this.goalTime < 4.5) return;
    if (d > 3.2 && Math.random() < p.propChance * 0.25) {
      const prop = this.pickProp();
      if (prop) {
        this.targetProp = prop;
        return this.setGoal('getProp');
      }
    }
    if (d > 2.1) return this.setGoal('approach');
    if (this.goal === 'circle' && this.goalTime < this.circleT) return;
    if (this.goal === 'fight' && Math.random() < 0.05 * (1.2 - p.aggression)) {
      this.circleT = rand(0.8, 2);
      return this.setGoal('circle');
    }
    this.setGoal('fight');
  }

  /** Go grab the opponent; hands must be free. */
  private goGrab() {
    const f = this.fighter;
    if (f.hold?.kind === 'prop' && this.dist() < 4) f.releaseHold('drop');
    return this.setGoal('grab');
  }

  private pickProp(): Prop | null {
    const f = this.fighter;
    const opp = f.opponent;
    let best: Prop | null = null;
    let bestScore = -Infinity;
    for (const pr of this.ctx.props.props) {
      if (pr.broken || pr.heldBy || pr.curP.y < -0.5 || pr.curP.y > 1.5) continue;
      if (!walkable(pr.curP.x, pr.curP.z)) continue;
      const d = Math.hypot(pr.curP.x - f.pos.x, pr.curP.z - f.pos.z);
      const dOpp = Math.hypot(pr.curP.x - opp.pos.x, pr.curP.z - opp.pos.z);
      if (d > 8 || dOpp < d * 0.8) continue;
      const cat = pr.def.category;
      let score = cat === 'blunt' ? 2.2 : cat === 'heavy' ? 1.6 : cat === 'fun' ? 1.0 : 0.6;
      if (pr.def.special === 'explode') score += 1.5;
      score -= d * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = pr;
      }
    }
    return bestScore > -0.5 ? best : null;
  }

  // ------------------------------------------------------------------ behaviours
  private faceTarget(p: THREE.Vector3, aimHeight?: number) {
    const f = this.fighter;
    const dx = p.x - f.pos.x;
    const dz = p.z - f.pos.z;
    this.aimNoise += (Math.random() - 0.5) * 0.4;
    this.aimNoise *= 0.9;
    this.yawTarget = yawFromDir(dx, dz) + this.aimNoise * this.params.aimError;
    const dist = Math.max(0.3, Math.hypot(dx, dz));
    const ty = aimHeight ?? f.opponent.pos.y + f.opponent.eyeHeight - 0.08;
    this.pitchTarget = clamp(Math.atan2(ty - (f.pos.y + f.eyeHeight), dist), -0.9, 0.7);
  }

  /** Context steering toward (tx,tz). Writes move intent in the fighter's local frame. */
  private steer(tx: number, tz: number, stopDist: number, allowEdge: boolean, speedScale = 1) {
    const f = this.fighter;
    const arena = this.ctx.arena;
    let dx = tx - f.pos.x;
    let dz = tz - f.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < stopDist) return false;
    dx /= dist;
    dz /= dist;
    let bx = 0;
    let bz = 0;
    let best = -Infinity;
    const opp = f.opponent;
    for (const [cx, cz] of DIRS) {
      let score = cx * dx + cz * dz;
      const px = f.pos.x + cx * 1.1;
      const pz = f.pos.z + cz * 1.1;
      if (arena.blockedXZ(f.pos.x, f.pos.z, px, pz, 0.3)) score -= 1.6;
      if (!allowEdge) {
        if (!walkable(px, pz)) score -= 2.5;
        const e = arena.distanceToOpenEdge(px, pz);
        if (e < 1.8) score -= (1.8 - e) * 1.1;
      }
      // don't plough straight through the opponent when going elsewhere
      if (this.goal !== 'approach' && this.goal !== 'fight') {
        const od = Math.hypot(opp.pos.x - px, opp.pos.z - pz);
        if (od < 0.9) score -= 0.8;
      }
      if (score > best) {
        best = score;
        bx = cx;
        bz = cz;
      }
    }
    const s = Math.min(1, dist / 0.6) * speedScale;
    this.setMove(bx * s, bz * s);
    return true;
  }

  private setMove(wx: number, wz: number) {
    const f = this.fighter;
    forwardFromYaw(f.yaw, _fwd);
    rightFromYaw(f.yaw, _right);
    f.intent.moveZ = clamp(wx * _fwd.x + wz * _fwd.z, -1, 1);
    f.intent.moveX = clamp(wx * _right.x + wz * _right.z, -1, 1);
  }

  private doFight(dt: number) {
    const f = this.fighter;
    const opp = f.opponent;
    const p = this.params;
    const d = this.dist();
    this.faceTarget(opp.pos);
    const arena = this.ctx.arena;
    // spacing
    if (d > 1.3) this.steer(opp.pos.x, opp.pos.z, 1.05, false, 0.9);
    else if (d < 0.85) {
      this.setMove((f.pos.x - opp.pos.x) / d, (f.pos.z - opp.pos.z) / d);
    } else {
      // small strafes while trading blows
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = rand(0.6, 1.6);
        this.strafeDir = chance(0.5) ? 1 : -1;
      }
      this.edgeAwareStrafe(0.45);
    }
    // never fight with your back to the void
    const myEdge = arena.distanceToOpenEdge(f.pos.x, f.pos.z);
    if (myEdge < 1.6) this.steer(0, 0, 0.5, false, 0.8);

    if (this.macro.length || this.attackCd > 0 || this.blockT > 0) return;
    if (d > 1.45) return;
    // choose an attack
    const oppEdge = arena.distanceToOpenEdge(opp.pos.x, opp.pos.z);
    const heavy = Math.random() < p.heavyChance;
    if (opp.state === FState.Stunned) {
      this.macro = chance(0.5) ? [{ btn: 'punchL', hold: rand(0.4, 0.8), after: 0.15 }] : [{ btn: 'punchR', hold: rand(0.5, 0.9), after: 0.2 }];
    } else if (oppEdge < 2.4 && this.behindOpponentFromEdge()) {
      this.macro = [{ btn: 'kick', hold: rand(0.35, 0.7), after: 0.3 }];
    } else if (opp.blocking) {
      this.macro = chance(0.55) ? [{ btn: 'kick', hold: chance(0.5) ? 0.5 : 0.02, after: 0.3 }] : [];
      if (!this.macro.length) {
        this.circleT = rand(0.5, 1.2);
        this.setGoal('circle');
      }
    } else if (heavy) {
      this.macro = [
        { btn: 'punchL', hold: 0.03, after: 0.12 },
        { btn: chance(0.5) ? 'punchR' : 'punchL', hold: rand(0.35, 0.8), after: 0.25 },
      ];
    } else {
      const combos: MacroStep[][] = [
        [{ btn: 'punchL', hold: 0.03, after: 0.18 }],
        [
          { btn: 'punchL', hold: 0.03, after: 0.15 },
          { btn: 'punchR', hold: 0.03, after: 0.25 },
        ],
        [
          { btn: 'punchL', hold: 0.03, after: 0.13 },
          { btn: 'punchL', hold: 0.03, after: 0.14 },
          { btn: 'punchR', hold: 0.03, after: 0.3 },
        ],
        [{ btn: 'kick', hold: 0.03, after: 0.3 }],
        [
          { btn: 'punchR', hold: 0.03, after: 0.18 },
          { btn: 'kick', hold: 0.03, after: 0.35 },
        ],
      ];
      this.macro = pick(combos).map((s) => ({ ...s }));
    }
    this.attackCd = rand(0.35, 1.1) / p.aggression;
  }

  /** Strafe while trying to get the opponent between us and the nearest open edge. */
  private edgeAwareStrafe(speed: number) {
    const f = this.fighter;
    const opp = f.opponent;
    const info = { edge: null as unknown, px: 0, pz: 0 };
    const de = this.ctx.arena.distanceToOpenEdge(opp.pos.x, opp.pos.z, info as never);
    let tx: number;
    let tz: number;
    if (de < 6) {
      // ideal spot: opposite side of the opponent from the edge
      const ex = info.px - opp.pos.x;
      const ez = info.pz - opp.pos.z;
      const el = Math.hypot(ex, ez) || 1;
      tx = opp.pos.x - (ex / el) * 1.1;
      tz = opp.pos.z - (ez / el) * 1.1;
    } else {
      rightFromYaw(f.yaw, _right);
      tx = f.pos.x + _right.x * this.strafeDir;
      tz = f.pos.z + _right.z * this.strafeDir;
    }
    this.steer(tx, tz, 0.25, false, speed);
  }

  private behindOpponentFromEdge() {
    const f = this.fighter;
    const opp = f.opponent;
    const info = { edge: null as unknown, px: 0, pz: 0 };
    this.ctx.arena.distanceToOpenEdge(opp.pos.x, opp.pos.z, info as never);
    const ex = info.px - opp.pos.x;
    const ez = info.pz - opp.pos.z;
    const ax = f.pos.x - opp.pos.x;
    const az = f.pos.z - opp.pos.z;
    const dot = (ex * ax + ez * az) / ((Math.hypot(ex, ez) || 1) * (Math.hypot(ax, az) || 1));
    return dot < -0.35;
  }

  private doCircle(dt: number) {
    const f = this.fighter;
    const opp = f.opponent;
    this.faceTarget(opp.pos);
    const d = this.dist();
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafeT = rand(0.5, 1.3);
      this.strafeDir = chance(0.5) ? 1 : -1;
    }
    if (d < 2.0) {
      // back off a bit while circling
      const ax = (f.pos.x - opp.pos.x) / (d || 1);
      const az = (f.pos.z - opp.pos.z) / (d || 1);
      this.steer(f.pos.x + ax * 1.5, f.pos.z + az * 1.5, 0.2, false, 0.7);
    } else this.edgeAwareStrafe(0.6);
    if (opp.blocking && d < 1.5 && chance(0.02)) this.macro = [{ btn: 'kick', hold: 0.03, after: 0.3 }];
  }

  private doRetreat() {
    const f = this.fighter;
    const opp = f.opponent;
    this.faceTarget(opp.pos);
    const d = this.dist() || 1;
    let tx = f.pos.x + ((f.pos.x - opp.pos.x) / d) * 3;
    let tz = f.pos.z + ((f.pos.z - opp.pos.z) / d) * 3;
    tx = clamp(tx, ROOF.minX + 3, ROOF.maxX - 3);
    tz = clamp(tz, ROOF.minZ + 3, ROOF.maxZ - 3);
    this.steer(tx, tz, 0.4, false, 0.85);
    if (d < 1.6 && opp.action && chance(0.5)) this.blockT = Math.max(this.blockT, 0.3);
    if (f.stamina > 65 || this.goalTime > 4) this.setGoal('approach');
  }

  private doGetProp() {
    const f = this.fighter;
    const prop = this.targetProp;
    if (!prop || prop.heldBy || prop.broken) {
      this.setGoal('approach');
      return;
    }
    this.faceTarget(prop.curP, prop.curP.y);
    this.steer(prop.curP.x, prop.curP.z, 0.7, false);
    f.intent.sprint = this.dist() > 3;
    if (this.interaction.canReachProp(f, prop)) {
      f.pickUpProp(prop);
      this.targetProp = null;
      this.setGoal('useProp');
    } else if (this.goalTime > 5) this.setGoal('approach');
  }

  private doUseProp(dt: number) {
    const f = this.fighter;
    const opp = f.opponent;
    const h = f.hold;
    if (!h || h.kind !== 'prop') {
      this.setGoal('approach');
      return;
    }
    const d = this.dist();
    if (h.twoHanded) {
      // lob it at the opponent
      const blocked = this.ctx.arena.blockedXZ(f.pos.x, f.pos.z, opp.pos.x, opp.pos.z, 0.15);
      const aimY = opp.pos.y + 1.1;
      this.faceTarget(opp.pos, aimY);
      this.pitchTarget += clamp(d * 0.028, 0, 0.3);
      if (d > 9 || blocked) this.steer(opp.pos.x, opp.pos.z, 2.5, false);
      else if (d < 1.2) this.setMove((f.pos.x - opp.pos.x) / (d || 1), (f.pos.z - opp.pos.z) / (d || 1));
      if (!this.macro.length && !blocked && d < 9 && this.attackCd <= 0) {
        this.macro = [{ btn: 'punchR', hold: clamp(d / 9, 0.25, 1) * 0.8, after: 0.4 }];
        this.attackCd = 1;
      }
      return;
    }
    // melee weapon
    this.faceTarget(opp.pos);
    const reach = 1.15 + h.prop.def.reach * 0.5;
    if (d > reach) this.steer(opp.pos.x, opp.pos.z, reach - 0.2, false);
    else if (d < 0.9) this.setMove((f.pos.x - opp.pos.x) / (d || 1), (f.pos.z - opp.pos.z) / (d || 1));
    else this.edgeAwareStrafe(0.4);
    if (!this.macro.length && this.attackCd <= 0 && d < reach + 0.2) {
      this.macro = [{ btn: 'punchL', hold: chance(this.params.heavyChance) ? rand(0.3, 0.7) : 0.03, after: 0.35 }];
      this.attackCd = rand(0.5, 1.2) / this.params.aggression;
      // light junk is better thrown
      if (h.prop.def.category === 'light' || (h.prop.def.category === 'fun' && h.prop.def.swing.damage < 4)) {
        if (d > 2.5 && chance(0.6)) this.macro = [{ btn: 'punchR', hold: 0.4, after: 0.4 }];
      }
    }
    void dt;
  }

  private doGrabOrStomp() {
    const f = this.fighter;
    const opp = f.opponent;
    if (!RULES[opp.state].grabbable && !opp.isDown) {
      this.setGoal('approach');
      return;
    }
    const body = opp.ragdoll.active ? opp.ragdoll.pelvisPos(_v) : _v.copy(opp.pos);
    if (this.goal === 'stomp') {
      // get on the inner side of the body and kick it over the edge
      const info = { edge: null as unknown, px: 0, pz: 0 };
      const de = this.ctx.arena.distanceToOpenEdge(body.x, body.z, info as never);
      const ex = info.px - body.x;
      const ez = info.pz - body.z;
      const el = Math.hypot(ex, ez) || 1;
      const sx = body.x - (ex / el) * 0.95;
      const sz = body.z - (ez / el) * 0.95;
      const arrived = !this.steer(sx, sz, 0.35, true, 0.9);
      this.faceTarget(body, body.y);
      if (de > 3) this.setGoal('grab');
      if (arrived && !this.macro.length && this.attackCd <= 0) {
        this.macro = [{ btn: 'kick', hold: rand(0.3, 0.6), after: 0.3 }];
        this.attackCd = 0.7;
      }
      return;
    }
    this.faceTarget(body, body.y);
    this.steer(body.x, body.z, 0.75, false);
    f.intent.sprint = Math.hypot(body.x - f.pos.x, body.z - f.pos.z) > 3;
    if (this.interaction.canReachFighter(f, opp)) {
      if (f.grabFighter(opp)) {
        this.throwSpot = null;
        this.setGoal('carry');
        if (chance(0.5)) this.say(pick(f.def.taunts), 3);
      }
    }
  }

  private doCarry(dt: number) {
    const f = this.fighter;
    const h = f.hold;
    if (!h || h.kind !== 'fighter') {
      this.setGoal('approach');
      return;
    }
    if (h.mode === 'drag') {
      if (this.goalTime > 0.25 && f.stamina > 22 && !this.macro.length) this.macro = [{ btn: 'interact', hold: 0.02, after: 0.4 }];
      else if (f.stamina <= 22 && !this.macro.length) {
        // too tired to lift: shove toward the void
        this.macro = [{ btn: 'punchL', hold: 0.3, after: 0.4 }];
      }
      return;
    }
    if (!this.throwSpot) this.throwSpot = this.ctx.arena.bestThrowSpot(f.pos.x, f.pos.z);
    const s = this.throwSpot;
    const arrived = !this.steer(s.x, s.z, 0.55, true, 1);
    const edgeD = this.ctx.arena.distanceToOpenEdge(f.pos.x, f.pos.z);
    // face outward when close
    const close = arrived || edgeD < 2.4 || this.goalTime > 6.5;
    if (close) {
      this.yawTarget = yawFromDir(s.nx, s.nz);
      this.pitchTarget = 0.32;
      f.intent.moveX = 0;
      f.intent.moveZ = 0;
      const facing = Math.abs(wrapAngle(this.yawTarget - f.yaw)) < 0.25;
      if (facing && !this.macro.length) {
        this.macro = [{ btn: 'punchR', hold: rand(0.55, 0.85), after: 0.5 }];
        this.say(pick(f.def.winLines), 2);
      }
    } else {
      this.yawTarget = yawFromDir(s.x - f.pos.x, s.z - f.pos.z);
      this.pitchTarget = 0;
    }
    void dt;
  }

  // ------------------------------------------------------------------ macro runner
  private runMacro(dt: number) {
    const f = this.fighter;
    const it = f.intent;
    const step = this.macro[0];
    // buttons default to released
    let L = false;
    let R = false;
    let K = false;
    if (step) {
      if (this.macroT === 0) {
        if (step.btn === 'interact') it.interact = true;
        if (step.btn === 'dodge') {
          it.dodge = true;
          // sidestep relative to facing
          it.moveX = this.dodgeSide;
          it.moveZ = -0.3;
        }
      }
      this.macroT += dt;
      const holding = this.macroT < step.hold;
      if (holding) {
        if (step.btn === 'punchL') L = true;
        if (step.btn === 'punchR') R = true;
        if (step.btn === 'kick') K = true;
      }
      if (this.macroT >= step.hold + step.after) {
        this.macro.shift();
        this.macroT = 0;
      }
    }
    it.punchL.set(L);
    it.punchR.set(R);
    it.kick.set(K);
  }
}
