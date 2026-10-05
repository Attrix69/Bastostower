import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../game/events';
import type { Fighter } from '../fighters/Fighter';
import { FState } from '../fighters/states';
import { chance, pick } from '../core/math';
import { AudioEngine, Tracked } from './Audio';

/**
 * Maps gameplay events to sounds: impacts by material & power, voices
 * (grunts, screams, gibberish taunts), stun birdies, KO trombone...
 */
export class AudioDirector {
  private screams = new Map<Fighter, Tracked>();
  private lastVoice = new Map<Fighter, number>();
  private now = () => performance.now() / 1000;
  private alarmed = false;

  constructor(
    readonly audio: AudioEngine,
    events: EventBus<GameEvents>,
  ) {
    const a = audio;
    const voiceOk = (f: Fighter, gap = 0.25) => {
      const t = this.now();
      if (t - (this.lastVoice.get(f) ?? 0) < gap) return false;
      this.lastVoice.set(f, t);
      return true;
    };
    const pos = (f: Fighter) => (f.ragdoll.active ? f.ragdoll.parts[1].curP.clone() : new THREE.Vector3(f.pos.x, f.pos.y + 1.5, f.pos.z));

    events.on('hit', (e) => {
      if (e.blocked) {
        a.block(e.point, e.perfect);
        return;
      }
      const sound = e.prop?.def.sound;
      if (e.kind === 'explosion') {
        /* the explosion itself is loud enough */
      } else if (e.kind === 'kick' || e.kind === 'body') a.kickHit(e.point, e.power);
      else a.punch(e.point, e.power, e.heavy);
      if (sound) a.material(sound, e.point, 10 + e.power * 4);
      if (voiceOk(e.victim, 0.18)) {
        const v = e.victim.def.voice;
        if (e.result === 'ko') a.voice(pos(e.victim), v * 0.9, 'o', 0.6, 0.6, 0.6);
        else a.voice(pos(e.victim), v * (e.heavy ? 1.15 : 1), pick(['o', 'a', 'u'] as const), e.heavy ? 0.28 : 0.16, e.heavy ? 0.55 : 0.4, 0.8);
      }
    });
    events.on('parry', (e) => a.block(e.point, true));
    events.on('whoosh', (e) => {
      a.whoosh(e.pos, e.heavy);
      if (e.heavy && voiceOk(e.fighter, 0.4) && chance(0.7)) a.voice(e.pos, e.fighter.def.voice * 1.1, chance(0.5) ? 'a' : 'e', 0.14, 0.45, 0.9);
      else if (chance(0.25) && voiceOk(e.fighter, 0.5)) a.voice(e.pos, e.fighter.def.voice * 1.2, 'e', 0.07, 0.25, 1);
    });
    events.on('footstep', (e) => a.footstep(e.pos, e.fighter.isPlayer ? e.intensity * 0.6 : e.intensity));
    events.on('land', (e) => a.land(e.pos, e.speed));
    events.on('jump', (e) => {
      if (chance(0.4)) a.voice(pos(e.fighter), e.fighter.def.voice * 1.2, 'u', 0.08, 0.2, 1.1);
    });
    events.on('dodge', (e) => a.whoosh(pos(e.fighter), false));
    events.on('bodyImpact', (e) => {
      a.bodySlam(e.pos, e.speed);
      // a body landing in the street, 120 m below: somebody's car takes it
      if (e.pos.y < -100 && !this.alarmed) {
        this.alarmed = true;
        a.carAlarm(e.pos);
        window.setTimeout(() => (this.alarmed = false), 4000);
      }
    });
    events.on('propImpact', (e) => {
      if (e.prop.def.special === 'squeak') a.squeak(e.pos);
      else a.material(e.prop.def.sound, e.pos, e.speed);
      if (e.pos.y < -100) a.carAlarm(e.pos);
    });
    events.on('propBreak', (e) => {
      const sp = e.prop.def.special;
      if (sp === 'splat') a.splat(e.pos);
      else if (sp === 'crumble') a.material(e.prop.def.sound, e.pos, 12);
      else if (e.prop.def.sound === 'ceramic') {
        a.material('ceramic', e.pos, 14);
        a.crash(e.pos, false);
      } else a.crash(e.pos, e.prop.def.mass > 5);
    });
    events.on('explosion', (e) => a.explosion(e.pos));
    events.on('railingBreak', (e) => {
      a.material('metal', e.pos, 16);
      a.crash(e.pos, true);
    });
    events.on('pickup', (e) => a.material(e.prop.def.sound, e.prop.curP, 3));
    events.on('throwProp', (e) => {
      a.whoosh(e.prop.curP, e.speed > 14);
      if (voiceOk(e.fighter)) a.voice(pos(e.fighter), e.fighter.def.voice, 'a', 0.16, 0.45, 0.9);
    });
    events.on('grab', (e) => {
      a.whoosh(pos(e.victim), false);
      a.voice(pos(e.attacker), e.attacker.def.voice * 0.95, 'o', 0.2, 0.4, 1.1);
    });
    events.on('lift', (e) => a.voice(pos(e.attacker), e.attacker.def.voice * 0.9, 'u', 0.45, 0.55, 1.25));
    events.on('throwBody', (e) => {
      a.whoosh(pos(e.victim), true);
      a.voice(pos(e.attacker), e.attacker.def.voice, 'a', 0.3, 0.6, 0.7);
      a.voice(pos(e.victim), e.victim.def.voice * 1.3, 'a', 0.5, 0.5, 1.3);
    });
    events.on('escape', (e) => a.voice(pos(e.victim), e.victim.def.voice * 1.2, 'a', 0.2, 0.5, 1));
    events.on('teeter', (e) => {
      if (voiceOk(e.fighter, 1.2)) {
        a.voice(pos(e.fighter), e.fighter.def.voice * 1.3, 'o', 0.18, 0.4, 1.3);
        window.setTimeout(() => a.voice(pos(e.fighter), e.fighter.def.voice * 1.4, 'a', 0.2, 0.4, 0.8), 220);
      }
    });
    events.on('taunt', (e) => a.babble(pos(e.fighter), e.fighter.def.voice * 1.4, e.text.length));
    events.on('exhausted', (e) => {
      for (let i = 0; i < 3; i++) window.setTimeout(() => a.voice(pos(e.fighter), e.fighter.def.voice * 0.8, 'a', 0.15, 0.15, 1), i * 280);
    });
    events.on('stateChange', (e) => {
      const f = e.fighter;
      if (e.to === FState.Stunned) {
        a.stunBirds(pos(f), Math.min(3.2, f.stunTimer));
        a.voice(pos(f), f.def.voice * 0.85, 'o', 0.5, 0.4, 0.75);
      }
      if (e.to === FState.KO) {
        a.koTrombone(pos(f));
        a.bell(3);
      }
      if (e.to === FState.Falling) {
        const s = a.scream(f.def.voice);
        if (s) {
          s.setPosition(pos(f));
          this.screams.set(f, s);
          window.setTimeout(() => this.screams.delete(f), 3400);
        }
      }
    });
  }

  update(fighters: Fighter[]) {
    for (const [f, s] of this.screams) {
      if (f.ragdoll.active) s.setPosition(f.ragdoll.parts[1].curP);
    }
    void fighters;
  }

  stopAll() {
    for (const s of this.screams.values()) s.stop();
    this.screams.clear();
  }
}
