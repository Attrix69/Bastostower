import * as THREE from 'three';
import type { GameContext } from '../game/Context';
import type { Fighter } from '../fighters/Fighter';
import type { Prop } from '../props/PropSystem';
import { RULES } from '../fighters/states';

/**
 * Context-sensitive "use" button (E): picks the best action for a fighter and
 * performs it — pick up / drop a prop, grab a dazed opponent, lift him over
 * your head, put him down. Exposes the current option for the HUD prompt.
 */

export type InteractionKind = 'pickup' | 'dropProp' | 'grab' | 'lift' | 'dropBody';

export interface InteractionOption {
  kind: InteractionKind;
  label: string;
  /** secondary hints shown under the prompt */
  hints: string[];
  prop?: Prop;
  target?: Fighter;
}

const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();

export const GRAB_RANGE = 1.9;

export class InteractionSystem {
  /** option for each fighter index, refreshed every step */
  readonly options: (InteractionOption | null)[] = [null, null];

  constructor(private ctx: GameContext) {}

  update() {
    for (const f of this.ctx.fighters) {
      const opt = this.computeOption(f);
      this.options[f.index] = opt;
      if (f.isPlayer) this.ctx.props.focus = opt?.kind === 'pickup' ? opt.prop ?? null : null;
      if (f.intent.interact && opt && this.ctx.live) this.perform(f, opt);
    }
  }

  canReachFighter(f: Fighter, target: Fighter) {
    if (!f.canGrab(target)) return false;
    target.ragdoll.active ? target.ragdoll.pelvisPos(_eye) : _eye.copy(target.pos);
    const dx = _eye.x - f.pos.x;
    const dz = _eye.z - f.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > GRAB_RANGE || Math.abs(_eye.y - (f.pos.y + 0.6)) > 1.6) return false;
    f.forward(_dir);
    return d < 0.7 || (dx * _dir.x + dz * _dir.z) / d > 0.15;
  }

  canReachProp(f: Fighter, p: Prop) {
    if (p.broken || p.heldBy) return false;
    const dx = p.curP.x - f.pos.x;
    const dz = p.curP.z - f.pos.z;
    return Math.hypot(dx, dz) < 1.7 && p.curP.y - f.pos.y < 1.9 && p.curP.y - f.pos.y > -0.6;
  }

  computeOption(f: Fighter): InteractionOption | null {
    const h = f.hold;
    if (h?.kind === 'prop') {
      return {
        kind: 'dropProp',
        label: `Lâcher ${h.prop.def.name}`,
        hints: h.twoHanded ? ['CLIC : lancer (maintenir = plus fort)'] : ['CLIC G : frapper', 'CLIC D : lancer (maintenir = plus fort)'],
        prop: h.prop,
      };
    }
    if (h?.kind === 'fighter') {
      if (h.mode === 'drag') return { kind: 'lift', label: 'Soulever !', hints: ['CLIC G : pousser', 'CLIC D : jeter'], target: h.target };
      return { kind: 'dropBody', label: 'Poser', hints: ['CLIC : JETER (maintenir = plus loin)'], target: h.target };
    }
    if (!RULES[f.state].interact) return null;
    const opp = f.opponent;
    if (this.canReachFighter(f, opp)) return { kind: 'grab', label: `Saisir ${opp.name}`, hints: [], target: opp };
    // props: aim-based for the player, proximity for the AI
    f.eye(_eye);
    f.aimQuat(_q);
    _dir.set(0, 0, -1).applyQuaternion(_q);
    let prop = this.ctx.props.findFocus(_eye, _dir, 2.6);
    if (!prop && !f.isPlayer) prop = this.ctx.props.nearest(f.pos, (p) => this.canReachProp(f, p), 1.7);
    if (prop && this.canReachProp(f, prop)) {
      const cat = prop.def.category;
      const tag = cat === 'heavy' ? 'lourd' : cat === 'blunt' ? 'arme' : cat === 'fun' ? '???' : 'léger';
      return { kind: 'pickup', label: `Ramasser ${prop.def.name}`, hints: [tag], prop };
    }
    return null;
  }

  perform(f: Fighter, opt: InteractionOption) {
    switch (opt.kind) {
      case 'pickup':
        if (opt.prop) f.pickUpProp(opt.prop);
        break;
      case 'dropProp':
        f.releaseHold('drop');
        break;
      case 'grab':
        if (opt.target) f.grabFighter(opt.target);
        break;
      case 'lift':
        f.liftHeld();
        break;
      case 'dropBody':
        f.releaseHold('drop');
        break;
    }
  }
}
