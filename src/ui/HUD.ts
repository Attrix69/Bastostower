import type { Fighter } from '../fighters/Fighter';
import { FState, RULES } from '../fighters/states';
import type { InteractionOption } from '../interaction/InteractionSystem';
import { HEAVY_THRESHOLD, MAX_CHARGE_TIME } from '../fighters/attacks';

/**
 * Minimal premium HUD (DOM overlay). Every write is cached so the DOM is only
 * touched when a value actually changes.
 */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

class Cached {
  private last = new Map<string, string | number | boolean>();
  set(key: string, v: string | number | boolean, apply: () => void) {
    if (this.last.get(key) === v) return;
    this.last.set(key, v);
    apply();
  }
  clear() {
    this.last.clear();
  }
}

const STATE_CLASS: Partial<Record<FState, string>> = {
  [FState.Hit]: '',
  [FState.Stunned]: 'warn',
  [FState.KO]: 'danger',
  [FState.Grabbed]: 'danger',
  [FState.Carried]: 'danger',
  [FState.Thrown]: 'warn',
  [FState.Falling]: 'danger',
};

export class HUD {
  readonly root = $('hud');
  private c = new Cached();
  private ghost = [1, 1];
  private ghostDelay = [0, 0];
  private lastHealth = [100, 100];
  private hintTimer = 14;
  private comboTimer = 0;

  show(v: boolean) {
    this.root.classList.toggle('hidden', !v);
    if (v) this.c.clear();
  }

  setNames(p: Fighter, e: Fighter) {
    $('pName').textContent = p.def.name;
    $('eName').textContent = e.def.name;
    $('eNick').textContent = e.def.nickname;
    this.ghost = [1, 1];
    this.lastHealth = [p.maxHealth, e.maxHealth];
    this.c.clear();
  }

  setScore(p: number, e: number) {
    $('scoreP').textContent = String(p);
    $('scoreE').textContent = String(e);
  }

  setBlockKey(k: string) {
    $('kBlock').textContent = k;
  }

  resetHints() {
    this.hintTimer = 14;
    $('controlsHint').style.opacity = '1';
  }

  update(dt: number, p: Fighter, e: Fighter, opt: InteractionOption | null, live: boolean) {
    this.bars(dt, 0, p, 'p');
    this.bars(dt, 1, e, 'e');

    // prompt
    const showPrompt = !!opt && live && !p.isDown;
    this.c.set('prompt', showPrompt ? `${opt!.kind}|${opt!.label}` : '', () => {
      $('prompt').classList.toggle('hidden', !showPrompt);
      if (showPrompt) {
        $('promptLabel').textContent = opt!.label;
        $('promptHints').textContent = opt!.hints.join('  ·  ');
      }
    });

    // escape mash
    const held = (p.state === FState.Grabbed || p.state === FState.Carried) && p.koTimer <= 0;
    this.c.set('mash', held, () => $('mash').classList.toggle('hidden', !held));
    if (held) this.c.set('mashv', Math.round(p.escape * 100), () => ($('mashFill').style.transform = `scaleX(${Math.min(1, p.escape)})`));

    // enemy KO timer
    const eKo = e.koTimer > 0 && e.isDown && e.state !== FState.Falling;
    const eKoText = eKo ? `K.O. ${e.koTimer.toFixed(1)}s — porte-le jusqu'au bord !` : e.state === FState.Stunned ? 'ÉTOURDI — attrape-le avec E !' : '';
    this.c.set('eko', eKoText, () => {
      $('enemyKo').classList.toggle('hidden', !eKoText);
      $('enemyKo').textContent = eKoText;
    });

    // charge ring
    const a = p.action;
    const charge = a && a.phase === 'hold' ? (a.heavy ? Math.min(1, Math.max(0, (a.holdTime - HEAVY_THRESHOLD) / MAX_CHARGE_TIME)) : a.button === 'throw' || a.button === 'swing' ? Math.min(1, a.holdTime / 0.75) : 0) : 0;
    this.c.set('charge', Math.round(charge * 40), () => {
      const el = $('charge');
      el.style.opacity = charge > 0.02 ? '1' : '0';
      el.style.setProperty('--p', String(charge));
    });

    // edge warning: the player is close to an open edge
    const warn = live && !p.isDown && p.teeter > 0.3;
    this.c.set('edge', warn, () => $('edgeWarn').classList.toggle('hidden', !warn));

    // stun overlay
    const stun = p.state === FState.Stunned;
    this.c.set('stun', stun, () => ($('stunOverlay').style.opacity = stun ? '1' : '0'));

    // combo counter
    if (p.combo >= 2) {
      this.c.set('combo', p.combo, () => {
        const el = $('combo');
        el.textContent = `COMBO ×${p.combo}`;
        el.classList.add('show');
        el.classList.remove('bump');
        void el.offsetWidth;
        el.classList.add('bump');
      });
      this.comboTimer = 1.2;
    } else if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        $('combo').classList.remove('show');
        this.c.set('combo', 0, () => {});
      }
    }

    this.c.set('hintVis', live, () => ($('controlsHint').style.visibility = live ? 'visible' : 'hidden'));
    if (this.hintTimer > 0 && live) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) $('controlsHint').style.opacity = '0';
    }
  }

  private bars(dt: number, i: number, f: Fighter, pre: string) {
    const h = Math.max(0, f.health / f.maxHealth);
    if (f.health < this.lastHealth[i] - 0.01) {
      this.ghostDelay[i] = 0.45;
      const panel = $(i === 0 ? 'pPanel' : 'ePanel');
      panel.classList.remove('shake');
      void panel.offsetWidth;
      panel.classList.add('shake');
    }
    this.lastHealth[i] = f.health;
    if (this.ghostDelay[i] > 0) this.ghostDelay[i] -= dt;
    else this.ghost[i] = Math.max(h, this.ghost[i] - dt * 0.6);
    if (this.ghost[i] < h) this.ghost[i] = h;
    this.c.set(pre + 'h', Math.round(h * 500), () => ($(pre + 'Health').style.transform = `scaleX(${h})`));
    this.c.set(pre + 'g', Math.round(this.ghost[i] * 500), () => ($(pre + 'Ghost').style.transform = `scaleX(${this.ghost[i]})`));
    if (pre === 'p') {
      const s = f.stamina / 100;
      this.c.set('ps', Math.round(s * 200), () => ($('pStamina').style.transform = `scaleX(${s})`));
      this.c.set('pslow', f.exhausted, () => ($('pStamina').parentElement as HTMLElement).classList.toggle('low', f.exhausted));
    }
    const daze = f.state === FState.Stunned ? Math.max(0, f.stunTimer / 3.5) : Math.min(1, f.daze / 100);
    this.c.set(pre + 'd', Math.round(daze * 200), () => ($(pre + 'Daze').style.transform = `scaleX(${daze})`));
    let label = RULES[f.state].label;
    if (f.state === FState.Thrown && f.koTimer > 0) label = 'ASSOMMÉ';
    if (f.exhausted && f.state === FState.Normal) label = 'ÉPUISÉ';
    if (f.blocking) label = 'GARDE';
    if (f.hold?.kind === 'fighter') label = f.hold.mode === 'carry' ? 'PORTE !' : 'TRAÎNE';
    const cls = f.exhausted && f.state === FState.Normal ? 'warn' : STATE_CLASS[f.state] ?? '';
    this.c.set(pre + 'st', label + cls, () => {
      const el = $(pre + 'State');
      el.textContent = label;
      el.className = 'fp-state' + (cls ? ' ' + cls : '');
    });
  }

  hitMarker(heavy: boolean) {
    const el = $('hitmarker');
    el.classList.remove('show', 'heavy');
    void el.offsetWidth;
    el.classList.add('show');
    if (heavy) el.classList.add('heavy');
  }

  announce(text: string, big = false) {
    const el = $('announcer');
    el.textContent = text;
    el.classList.remove('show', 'big');
    void el.offsetWidth;
    el.classList.add('show');
    if (big) el.classList.add('big');
  }

  flash(color: string, strength: number) {
    const el = $('flash');
    el.style.transition = 'none';
    el.style.background = color;
    el.style.opacity = String(Math.min(0.85, strength));
    void el.offsetWidth;
    el.style.transition = 'opacity 0.35s ease-out';
    el.style.opacity = '0';
  }
}
