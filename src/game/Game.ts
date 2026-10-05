import * as THREE from 'three';
import { Engine, QUALITY } from '../core/Engine';
import { EventBus } from '../core/EventBus';
import { Input } from '../core/Input';
import { Loop } from '../core/Loop';
import { clamp, pick } from '../core/math';
import { Physics } from '../physics/Physics';
import { Arena } from '../world/Arena';
import { City, Sky } from '../world/City';
import { Materials } from '../world/materials';
import { PropSystem } from '../props/PropSystem';
import { Fighter } from '../fighters/Fighter';
import { PLAYER_CHARACTER, ROSTER } from '../fighters/Characters';
import { FState } from '../fighters/states';
import { PlayerController } from '../control/PlayerController';
import { AIController, Difficulty } from '../control/AIController';
import { CombatSystem } from '../combat/CombatSystem';
import { InteractionSystem } from '../interaction/InteractionSystem';
import { FX } from '../fx/FX';
import { AimArc } from '../fx/AimArc';
import { AudioEngine } from '../audio/Audio';
import { AudioDirector } from '../audio/AudioDirector';
import { CameraRig } from '../camera/CameraRig';
import { ViewModel } from '../view/ViewModel';
import { HUD } from '../ui/HUD';
import type { GameContext } from './Context';
import type { FallCause, GameEvents } from './events';
import { loadSettings, saveSettings, Settings } from './Settings';

/**
 * Top-level orchestrator: owns every system, runs the fixed-step simulation
 * in a strict order, drives the match flow and wires gameplay events to
 * camera / HUD / post-processing feedback.
 *
 * Flow: menu → intro (3-2-1) → fight → finish (slow-mo fall cam) → results → (instant rematch)
 */

type Flow = 'menu' | 'intro' | 'fight' | 'finish' | 'results' | 'paused';

const $ = (id: string) => document.getElementById(id)!;

const METHOD: Record<FallCause, string> = {
  thrown: 'Lancé dans le vide',
  pushed: 'Poussé hors du toit',
  prop: 'Dégommé par un objet',
  explosion: "Soufflé par l'explosion",
  self: 'Chute accidentelle… la honte',
};

export class Game {
  readonly engine: Engine;
  readonly physics: Physics;
  readonly loop: Loop;
  readonly input: Input;
  readonly events = new EventBus<GameEvents>();
  readonly materials = new Materials();
  readonly arena: Arena;
  readonly city: City;
  readonly sky: Sky;
  readonly props: PropSystem;
  readonly player: Fighter;
  readonly enemies: Fighter[] = [];
  enemy: Fighter;
  readonly playerCtrl: PlayerController;
  readonly ais = new Map<Fighter, AIController>();
  readonly combat: CombatSystem;
  readonly interaction: InteractionSystem;
  readonly fx: FX;
  readonly aimArc = new AimArc();
  readonly audio = new AudioEngine();
  readonly audioDir: AudioDirector;
  readonly cam: CameraRig;
  readonly vm: ViewModel;
  readonly hud = new HUD();
  readonly ctx: GameContext;
  settings: Settings;
  flow: Flow = 'menu';
  private prevFlow: Flow = 'fight';
  private flowReal = 0;
  private countdownStep = -1;
  private score = { p: 0, e: 0 };
  private matchStart = 0;
  private finishInfo: { playerWon: boolean; method: string; shownWinner: boolean } | null = null;
  private damagePulse = 0;
  private aberration = 0;
  private lastEnemy: Fighter | null = null;
  private envMap: THREE.Texture | null = null;
  readonly debug = new URLSearchParams(location.search).has('debug');

  static async create(canvas: HTMLCanvasElement, progress: (k: number, text: string) => void) {
    progress(0.1, 'Réveil du moteur physique…');
    const physics = await Physics.init();
    progress(0.35, 'Construction du toit…');
    await nextFrame();
    const g = new Game(canvas, physics, progress);
    progress(1, 'Prêt à la baston !');
    return g;
  }

  private constructor(canvas: HTMLCanvasElement, physics: Physics, progress: (k: number, text: string) => void) {
    this.physics = physics;
    this.engine = new Engine(canvas);
    this.settings = loadSettings({ quality: this.engine.quality });
    const qParam = new URLSearchParams(location.search).get('q');
    if (qParam === 'low' || qParam === 'medium' || qParam === 'high') this.settings.quality = qParam;
    this.input = new Input(canvas);
    this.input.allowUnlocked = this.debug;
    this.input.onLayoutDetected = () => this.applySettings();
    this.loop = new Loop(
      (dt, real) => this.fixedUpdate(dt, real),
      (alpha, real) => this.render(alpha, real),
    );
    const self = this;
    const ctx: GameContext = {
      physics,
      arena: null!,
      events: this.events,
      loop: this.loop,
      fighters: [],
      props: null!,
      get time() {
        return self.loop.gameTime;
      },
      get live() {
        return self.flow === 'fight';
      },
    };
    this.ctx = ctx;

    // ---- world
    const scene = this.engine.scene;
    scene.fog = new THREE.FogExp2(0x7d5a7a, 0.0021);
    this.sky = new Sky();
    scene.add(this.sky.mesh, this.sky.clouds);
    this.arena = new Arena(physics, this.materials);
    ctx.arena = this.arena;
    scene.add(this.arena.group);
    progress(0.5, 'Allumage de la ville…');
    this.city = new City(scene.fog as THREE.FogExp2, 1);
    scene.add(this.city.group);
    this.buildEnvironment();

    // ---- props & fighters
    progress(0.65, 'Livraison des parpaings…');
    this.props = new PropSystem(ctx, this.materials);
    ctx.props = this.props;
    scene.add(this.props.group);
    progress(0.75, 'Échauffement des combattants…');
    this.player = new Fighter(ctx, 0, PLAYER_CHARACTER, true);
    scene.add(this.player.rig.mesh);
    for (const def of ROSTER) {
      const e = new Fighter(ctx, 1, def, false);
      e.setActive(false);
      scene.add(e.rig.mesh);
      this.enemies.push(e);
    }
    this.enemy = this.enemies[0];
    this.enemy.setActive(true);
    this.wireOpponents();

    // ---- systems
    this.interaction = new InteractionSystem(ctx);
    this.combat = new CombatSystem(ctx);
    for (const e of this.enemies) this.ais.set(e, new AIController(ctx, e, this.interaction, this.settings.difficulty));
    this.playerCtrl = new PlayerController(this.input, this.player);
    this.fx = new FX(this.events, () => ctx.fighters);
    scene.add(this.fx.group, this.aimArc.mesh);
    this.audioDir = new AudioDirector(this.audio, this.events);
    this.cam = new CameraRig(this.engine.camera, physics);
    this.vm = new ViewModel(this.engine.vmScene, PLAYER_CHARACTER.look, this.envMap);
    progress(0.9, 'Derniers réglages…');

    this.applySettings();
    this.wireEvents();
    this.wireUI();
    this.engine.onQualityChanged = () => this.applyQuality();
    this.applyQuality();

    // menu backdrop: both fighters idle on the roof
    this.player.spawn(this.arena.spawns.player.pos, this.arena.spawns.player.yaw);
    this.enemy.spawn(this.arena.spawns.enemy.pos, this.arena.spawns.enemy.yaw);
    this.playerCtrl.reset(this.arena.spawns.player.yaw);
    this.cam.setMode('menu', 0);
    this.loop.start();
    if (this.debug) (window as any).bastos = this;
  }

  private wireOpponents() {
    this.ctx.fighters.length = 0;
    this.ctx.fighters.push(this.player, this.enemy);
    this.player.opponent = this.enemy;
    this.enemy.opponent = this.player;
  }

  private buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.engine.renderer);
    const envScene = new THREE.Scene();
    const skyClone = new THREE.Mesh(this.sky.mesh.geometry, this.sky.mesh.material);
    envScene.add(skyClone);
    const rt = pmrem.fromScene(envScene, 0.04, 0.1, 3000);
    this.envMap = rt.texture;
    this.engine.scene.environment = rt.texture;
    this.engine.scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }

  // ------------------------------------------------------------------ settings & UI
  private applyQuality() {
    const q = QUALITY[this.engine.quality];
    this.arena.setShadowMapSize(q.shadowSize);
    this.fx.budget = q.particleBudget;
  }

  private applySettings() {
    const s = this.settings;
    this.playerCtrl.sensitivity = s.sensitivity;
    this.cam.baseFov = s.fov;
    this.audio.setVolume(s.volume);
    this.audio.setMusic(s.music);
    this.fx.gore = s.gore;
    this.input.layout = s.layout === 'auto' ? this.input.detectedLayout : s.layout;
    this.hud.setBlockKey(this.input.layout === 'azerty' ? 'A' : 'Q');
    for (const ai of this.ais.values()) ai.setDifficulty(s.difficulty as Difficulty);
    if (this.engine.quality !== s.quality) this.engine.setQuality(s.quality);
    saveSettings(s);
  }

  private wireUI() {
    const seg = (id: string, get: () => string, set: (v: string) => void) => {
      const el = $(id);
      const refresh = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === get()));
      el.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest('button');
        if (!b?.dataset.v) return;
        set(b.dataset.v);
        this.applySettings();
        refresh();
        this.audio.init();
        this.audio.click();
      });
      refresh();
    };
    const opp = $('oppSeg');
    opp.innerHTML = `<button data-v="random">Aléatoire</button>` + ROSTER.map((r) => `<button data-v="${r.id}">${r.name}</button>`).join('');
    seg('oppSeg', () => this.settings.opponent, (v) => (this.settings.opponent = v));
    seg('diffSeg', () => this.settings.difficulty, (v) => (this.settings.difficulty = v as Difficulty));
    seg('qualSeg', () => this.settings.quality, (v) => (this.settings.quality = v as Settings['quality']));
    seg('layoutSeg', () => this.settings.layout, (v) => (this.settings.layout = v as Settings['layout']));
    seg('goreSeg', () => this.settings.gore, (v) => (this.settings.gore = v as Settings['gore']));
    seg('musicSeg', () => (this.settings.music ? 'on' : 'off'), (v) => (this.settings.music = v === 'on'));
    const range = (id: string, out: string, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
      const el = $(id) as HTMLInputElement;
      const o = $(out);
      el.value = String(get());
      o.textContent = fmt(get());
      el.addEventListener('input', () => {
        set(parseFloat(el.value));
        o.textContent = fmt(get());
        this.applySettings();
      });
    };
    range('sensRange', 'sensOut', () => this.settings.sensitivity, (v) => (this.settings.sensitivity = v), (v) => v.toFixed(2));
    range('fovRange', 'fovOut', () => this.settings.fov, (v) => (this.settings.fov = v), (v) => `${v}°`);
    range('volRange', 'volOut', () => this.settings.volume, (v) => (this.settings.volume = v), (v) => `${Math.round(v * 100)}%`);

    $('playBtn').addEventListener('click', () => this.startMatch());
    $('againBtn').addEventListener('click', () => this.startMatch());
    $('restartBtn').addEventListener('click', () => this.startMatch());
    $('resumeBtn').addEventListener('click', () => this.resume());
    $('menuBtn').addEventListener('click', () => this.toMenu());
    $('resMenuBtn').addEventListener('click', () => this.toMenu());
    this.engine.canvas.addEventListener('click', () => {
      if (this.flow === 'paused') this.resume();
      else if ((this.flow === 'fight' || this.flow === 'intro') && !this.input.locked && !this.debug) this.input.requestLock();
    });
    this.input.onPointerLockChange = (locked) => {
      if (!locked && (this.flow === 'fight' || this.flow === 'intro') && !this.debug && !this.input.allowUnlocked) this.pause();
      if (locked && this.flow === 'paused') this.unpause();
    };
    window.addEventListener('keydown', (e) => {
      if (this.flow === 'results' && (e.code === 'KeyR' || e.code === 'Enter' || e.code === 'Space')) {
        e.preventDefault();
        this.startMatch();
      } else if (this.flow === 'menu' && e.code === 'Enter') this.startMatch();
      else if ((this.flow === 'fight' || this.flow === 'intro') && (e.code === 'Escape' || e.code === 'KeyP') && this.debug) this.pause();
    });
  }

  private showScreen(id: 'menu' | 'pause' | 'results' | null) {
    for (const s of ['menu', 'pause', 'results', 'loading']) $(s).classList.toggle('hidden', s !== id);
  }

  showMenu() {
    this.showScreen('menu');
    this.hud.show(false);
  }

  // ------------------------------------------------------------------ match flow
  startMatch() {
    this.audio.init();
    this.audio.startAmbience();
    this.audio.click();
    // opponent
    let next: Fighter;
    if (this.settings.opponent === 'random') {
      const pool = this.enemies.filter((e) => e !== this.lastEnemy);
      next = pick(pool.length ? pool : this.enemies);
    } else next = this.enemies.find((e) => e.def.id === this.settings.opponent) ?? this.enemies[0];
    if (next !== this.enemy) {
      this.enemy.setActive(false);
      this.enemy = next;
      this.enemy.setActive(true);
      this.wireOpponents();
    }
    this.lastEnemy = next;
    this.applySettings();

    this.loop.clearTimeEffects();
    this.audio.setMuffle(0);
    this.audioDir.stopAll();
    this.arena.reset();
    this.props.reset();
    this.fx.reset();
    this.player.spawn(this.arena.spawns.player.pos, this.arena.spawns.player.yaw);
    this.enemy.spawn(this.arena.spawns.enemy.pos, this.arena.spawns.enemy.yaw);
    this.player.animator.victory = false;
    this.enemy.animator.victory = false;
    this.playerCtrl.reset(this.arena.spawns.player.yaw);
    this.ais.get(this.enemy)!.reset();
    this.hud.setNames(this.player, this.enemy);
    this.hud.setScore(this.score.p, this.score.e);
    this.hud.resetHints();
    this.hud.show(true);
    this.showScreen(null);
    this.cam.setMode('fps', this.flow === 'menu' ? 1.4 : 0.6);
    this.flow = 'intro';
    this.flowReal = 0;
    this.countdownStep = -1;
    this.finishInfo = null;
    if (!this.debug) this.input.requestLock();
  }

  private pause() {
    if (this.flow !== 'fight' && this.flow !== 'intro') return;
    this.prevFlow = this.flow;
    this.flow = 'paused';
    this.input.releaseAll();
    this.showScreen('pause');
  }

  private resume() {
    if (this.debug) this.unpause();
    else this.input.requestLock();
  }

  private unpause() {
    if (this.flow !== 'paused') return;
    this.flow = this.prevFlow;
    this.showScreen(null);
  }

  private toMenu() {
    this.input.exitLock();
    this.flow = 'menu';
    this.cam.setMode('menu', 1.2);
    this.loop.clearTimeEffects();
    this.audio.setMuffle(0);
    this.showMenu();
  }

  private startFinish(falling: Fighter, cause: FallCause) {
    if (this.flow !== 'fight' && this.flow !== 'intro') return;
    const playerWon = falling === this.enemy;
    if (playerWon) this.score.p++;
    else this.score.e++;
    this.hud.setScore(this.score.p, this.score.e);
    this.flow = 'finish';
    this.flowReal = 0;
    this.loop.slowmo(0.2, 1.5);
    this.audio.setMuffle(0.75);
    this.cam.startFinish(falling, falling.opponent);
    let method = METHOD[cause];
    const la = falling.lastAttacker;
    if (cause === 'prop' && la?.prop) method = `Dégommé par : ${la.prop}`;
    this.finishInfo = { playerWon, method, shownWinner: false };
    this.hud.announce(playerWon ? pick(['AU REVOIR !', 'BON VOL !', 'QUEL VOL !', 'ADIEU !', 'BYE BYE !']) : pick(['NOOOON !', 'OUPS…', 'AÏE AÏE AÏE', 'PAS LE VIDE !']), true);
    const winner = falling.opponent;
    window.setTimeout(() => {
      if (this.flow === 'finish' && !winner.isDown) winner.animator.victory = true;
    }, 700);
    if (!playerWon) {
      const ai = this.ais.get(this.enemy);
      window.setTimeout(() => ai?.say(pick(this.enemy.def.winLines), 0), 900);
    }
  }

  private showResults() {
    const info = this.finishInfo!;
    this.flow = 'results';
    this.input.exitLock();
    this.audio.setMuffle(0.4);
    this.audio.fanfare(info.playerWon);
    const t = $('resTitle');
    t.textContent = info.playerWon ? 'VICTOIRE !' : 'DÉFAITE…';
    t.classList.toggle('lose', !info.playerWon);
    $('resMethod').textContent = (info.playerWon ? `${this.enemy.def.name} : ` : 'Toi : ') + info.method;
    $('resScore').textContent = `${this.score.p} — ${this.score.e}`;
    const s = this.player.stats;
    const dur = Math.max(0, this.loop.gameTime - this.matchStart);
    $('resStats').innerHTML = [
      ['Coups portés', s.hits],
      ['Dégâts infligés', Math.round(s.damage)],
      ['Meilleur combo', s.maxCombo],
      ['Objets lancés', s.propsThrown],
      ['Adversaires jetés', s.throws],
      ['Parades', s.blocks],
      ['Durée', `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}`],
    ]
      .map(([k, v]) => `<span>${k}</span><b>${v}</b>`)
      .join('');
    this.showScreen('results');
  }

  // ------------------------------------------------------------------ events → feedback
  private wireEvents() {
    const ev = this.events;
    ev.on('hit', (e) => {
      const p = this.player;
      if (e.attacker === p && e.victim !== p) {
        this.hud.hitMarker(e.heavy || e.power > 1.1);
        const a = p.action;
        const k = a?.def.camKick ?? [0.02, 0, 0];
        this.cam.kick(k[0] * 0.6 + 0.01, k[1] * 0.5, k[2] * 0.5, e.heavy ? -2.5 : -0.8);
        this.cam.addTrauma(e.heavy ? 0.28 : 0.1);
        if (e.heavy) this.aberration = 0.005;
      }
      if (e.victim === p) {
        // camera snaps in the hit direction
        const right = new THREE.Vector3(Math.cos(this.playerCtrl.yaw), 0, -Math.sin(this.playerCtrl.yaw));
        const side = right.dot(e.dir);
        this.cam.kick(-0.05 * e.power - 0.02, -side * 0.06 * e.power, side * 0.08 * e.power, 3 * e.power);
        this.cam.addTrauma(e.blocked ? 0.12 : 0.22 + e.power * 0.25);
        this.vm.flinchHit(e.blocked ? 0.4 : 1 + e.power);
        if (!e.blocked) {
          this.damagePulse = Math.min(1, this.damagePulse + 0.35 + e.power * 0.3);
          this.aberration = Math.max(this.aberration, 0.003 + e.power * 0.003);
          if (e.heavy) this.hud.flash('#ff2040', 0.18);
        }
      }
      if (e.result === 'stun') this.hud.announce(e.victim === p ? 'T\'ES SONNÉ !' : 'ÉTOURDI !');
      else if (e.result === 'ko') this.hud.announce('K.O. !', true);
      else if (e.result === 'guardbreak') this.hud.announce('GARDE BRISÉE !');
    });
    ev.on('parry', (e) => {
      if (e.victim === this.player) this.hud.announce('PARADE !');
      this.cam.addTrauma(0.15);
    });
    ev.on('whoosh', (e) => {
      if (e.fighter !== this.player) return;
      const a = this.player.action;
      if (!a) return;
      const [px, py, pz] = a.def.camKick;
      this.cam.kick(px * 0.5, py * 0.4, pz * 0.4, e.heavy ? 2 : 0.6);
    });
    ev.on('land', (e) => {
      if (e.fighter === this.player) this.cam.landDip(e.speed);
    });
    ev.on('grab', (e) => {
      if (e.attacker === this.player) this.hud.announce('SAISI !');
      else this.hud.announce('OH NON !');
    });
    ev.on('lift', (e) => {
      if (e.attacker === this.player) this.hud.announce('AU BORD, VITE !');
    });
    ev.on('throwBody', (e) => {
      if (e.speed > 13) this.loop.slowmo(0.45, 0.35);
      if (e.attacker === this.player) this.cam.addTrauma(0.25);
    });
    ev.on('escape', (e) => {
      if (e.victim === this.player) this.hud.announce('LIBÉRÉ !');
    });
    ev.on('explosion', (e) => {
      const d = this.engine.camera.position.distanceTo(e.pos);
      this.cam.addTrauma(clamp(1.2 - d / 18, 0.15, 1));
      this.loop.slowmo(0.35, 0.4);
      this.hud.announce('BOUM !');
    });
    ev.on('railingBreak', () => this.cam.addTrauma(0.2));
    ev.on('bodyImpact', (e) => {
      const d = this.engine.camera.position.distanceTo(e.pos);
      if (d < 8) this.cam.addTrauma(Math.min(0.3, e.speed / 40));
    });
    ev.on('fall', (e) => this.startFinish(e.fighter, e.cause));
    ev.on('exhausted', (e) => {
      if (e.fighter === this.player) this.hud.announce('ÉPUISÉ…');
    });
    this.fx.onScreenFlash = (c, s) => this.hud.flash(`#${new THREE.Color(c).getHexString()}`, s * 0.6);
  }

  // ------------------------------------------------------------------ simulation
  private fixedUpdate(dt: number, real: number) {
    if (this.flow === 'paused') {
      this.input.endStep(real);
      return;
    }
    const live = this.flow === 'fight';
    this.playerCtrl.update(live && (this.input.locked || this.input.allowUnlocked));
    const ai = this.ais.get(this.enemy)!;
    ai.update(dt);
    this.interaction.update();
    this.props.preStep(dt);
    for (const f of this.ctx.fighters) f.fixedUpdate(dt);
    this.physics.step(dt);
    this.props.postStep();
    for (const f of this.ctx.fighters) f.postPhysics(dt);
    this.combat.update(dt);
    this.arena.update(dt, this.loop.gameTime);
    this.input.endStep(real);
  }

  private render(alpha: number, realDt: number) {
    // ---- flow timers (real time)
    this.flowReal += realDt;
    if (this.flow === 'intro') this.updateIntro();
    if (this.flow === 'finish' && this.finishInfo) {
      if (!this.finishInfo.playerWon && !this.finishInfo.shownWinner && this.flowReal > 2.6) {
        this.finishInfo.shownWinner = true;
        this.cam.showWinner(this.enemy);
      }
      if (this.flowReal > (this.finishInfo.playerWon ? 3.4 : 4.6)) this.showResults();
    }

    // ---- look
    const [dx, dy] = this.input.consumeMouse();
    if (this.flow === 'fight' || this.flow === 'intro' || this.flow === 'finish') this.playerCtrl.look(dx, dy);

    // ---- interpolated visuals
    for (const f of this.ctx.fighters) f.render(alpha);
    this.props.render(alpha);

    // ---- camera mode
    const p = this.player;
    if (this.flow === 'intro' || this.flow === 'fight') {
      const thirdPerson = p.isDown || !!p.heldBy;
      this.cam.setMode(thirdPerson ? 'orbit' : 'fps', thirdPerson ? 0.45 : 0.55);
    }
    const gameDt = realDt * this.loop.timeScale;
    this.cam.update(realDt, gameDt, alpha, p, this.playerCtrl.yaw, this.playerCtrl.pitch);
    const cam = this.engine.camera;
    // view model shares the world FOV so held props, fists and hitboxes line up on screen
    const vmCam = this.engine.vmCamera;
    if (Math.abs(vmCam.fov - cam.fov) > 0.01) {
      vmCam.fov = cam.fov;
      vmCam.updateProjectionMatrix();
    }
    // the player's own body: invisible in first person but still casts its shadow
    const fp = this.cam.mode === 'fps' && this.flow !== 'menu';
    if (p.rig.material.colorWrite === fp) {
      p.rig.material.colorWrite = !fp;
      p.rig.material.depthWrite = !fp;
      p.rig.stars.visible = p.rig.stars.visible && !fp;
    }
    this.sky.mesh.position.copy(cam.position);
    this.vm.update(realDt, alpha, p, cam, this.sky.sunDir, this.playerCtrl.yaw, this.playerCtrl.pitch, this.cam.bob, fp && this.flow !== 'results');

    // ---- fx, world anims
    this.fx.update(gameDt, cam);
    this.aimArc.update(realDt, p);
    this.city.update(this.loop.realTime);
    this.sky.update(this.loop.realTime);
    this.hud.update(realDt, p, this.enemy, this.interaction.options[0], this.flow === 'fight');

    // ---- post fx
    const fx = this.engine.fx;
    this.damagePulse = Math.max(0, this.damagePulse - realDt * 1.6);
    const lowHp = p.health < 30 && this.flow === 'fight' ? (1 - p.health / 30) * (0.25 + 0.15 * Math.sin(this.loop.realTime * 6)) : 0;
    fx.u('uDamage').value = Math.min(0.85, this.damagePulse * 0.55 + lowHp);
    const stun = p.state === FState.Stunned ? 1 : 0;
    fx.u('uStun').value += (stun - fx.u('uStun').value) * Math.min(1, realDt * 4);
    this.aberration = Math.max(0, this.aberration - realDt * 0.02);
    fx.u('uAberration').value = this.aberration;
    const slow = 1 - this.loop.timeScale;
    fx.u('uSat').value = this.flow === 'finish' ? 1 - Math.min(0.55, slow * 0.7) : 1 + Math.min(0.15, slow * 0.2);
    const flying = p.isDown && p.ragdoll.active ? Math.min(1, p.ragdoll.speed() / 14) : 0;
    fx.u('uSpeed').value = flying * 0.04;

    // ---- audio
    this.audio.updateListener(cam);
    this.audio.updateMusic();
    this.audio.setMusicIntensity(this.flow === 'fight' ? clamp(1 - Math.min(p.health, this.enemy.health) / 100 + 0.3, 0, 1) : 0);
    this.audioDir.update(this.ctx.fighters);

    this.engine.adaptResolution(this.loop.frameMs, realDt);
    this.engine.render(realDt);
  }

  private updateIntro() {
    const t = this.flowReal;
    const step = t < 0.6 ? -1 : t < 1.45 ? 0 : t < 2.3 ? 1 : t < 3.15 ? 2 : 3;
    if (step !== this.countdownStep) {
      this.countdownStep = step;
      if (step >= 0 && step < 3) {
        this.hud.announce(String(3 - step));
        this.audio.beep(false);
      } else if (step === 3) {
        this.hud.announce('BASTON !', true);
        this.audio.beep(true);
        this.flow = 'fight';
        this.matchStart = this.loop.gameTime;
        const ai = this.ais.get(this.enemy);
        window.setTimeout(() => ai?.say(pick(this.enemy.def.taunts), 0), 600);
      }
    }
  }
}

function nextFrame() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}
