import * as THREE from 'three';

/**
 * Fully synthesized audio engine (WebAudio) — no sound files.
 * Every effect is a tiny node graph built on demand from "recipes":
 * oscillators with pitch envelopes, filtered noise, formant voices...
 * Spatialized with equal-power panners; voice count is capped.
 */

type Vec = THREE.Vector3 | null;

const VOWELS: Record<string, [number, number, number]> = {
  a: [800, 1200, 2600],
  o: [500, 850, 2500],
  u: [350, 650, 2300],
  e: [480, 1850, 2600],
  i: [310, 2250, 3000],
};

export class Tracked {
  constructor(public panner: PannerNode | null, public stop: () => void) {}
  setPosition(p: THREE.Vector3) {
    if (!this.panner) return;
    const t = this.panner.context.currentTime;
    this.panner.positionX.setTargetAtTime(p.x, t, 0.03);
    this.panner.positionY.setTargetAtTime(p.y, t, 0.03);
    this.panner.positionZ.setTargetAtTime(p.z, t, 0.03);
  }
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private ambBus!: GainNode;
  private musicFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  private shaper!: WaveShaperNode;
  private voices = 0;
  private maxVoices = 30;
  volume = 0.8;
  musicVolume = 0.35;
  musicOn = true;
  private musicTimer = 0;
  private musicStep = 0;
  private nextNoteTime = 0;
  private musicIntensity = 0;
  private ambienceStarted = false;
  private listenerPos = new THREE.Vector3();
  private lf = new THREE.Vector3();
  private lu = new THREE.Vector3();

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' }) as AudioContext;
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 18000;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicOn ? this.musicVolume : 0;
    this.musicBus.connect(this.musicFilter);
    this.musicFilter.connect(this.master);
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 0.5;
    this.ambBus.connect(this.master);

    // noise buffers
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      b[i] = last * 3.5;
    }
    this.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 3.2);
    }
    this.shaper.curve = curve;
    this.shaper.connect(this.sfxBus);
    ctx.listener.positionX && (ctx.listener.positionX.value = 0);
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setMusic(on: boolean, vol = this.musicVolume) {
    this.musicOn = on;
    this.musicVolume = vol;
    if (this.ctx) this.musicBus.gain.setTargetAtTime(on ? vol : 0, this.ctx.currentTime, 0.2);
  }

  /** Dramatic muffle (slow motion) 0..1 */
  setMuffle(k: number) {
    if (!this.ctx) return;
    this.musicFilter.frequency.setTargetAtTime(18000 * Math.pow(1 - k, 3) + 350, this.ctx.currentTime, 0.08);
  }

  setMusicIntensity(k: number) {
    this.musicIntensity = k;
  }

  updateListener(cam: THREE.Camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    cam.getWorldPosition(this.listenerPos);
    const fwd = this.lf.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const up = this.lu.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(this.listenerPos.x, t, 0.02);
      l.positionY.setTargetAtTime(this.listenerPos.y, t, 0.02);
      l.positionZ.setTargetAtTime(this.listenerPos.z, t, 0.02);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(up.z, t, 0.02);
    } else {
      (l as any).setPosition(this.listenerPos.x, this.listenerPos.y, this.listenerPos.z);
      (l as any).setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  // ------------------------------------------------------------------ plumbing
  /** Output node for a one-shot at `pos` (or non-positional), with voice accounting. */
  private out(pos: Vec, dur: number, gain = 1, priority = 1): { node: AudioNode; panner: PannerNode | null } | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    if (this.voices >= this.maxVoices && priority < 2) return null;
    this.voices++;
    window.setTimeout(() => this.voices--, (dur + 0.1) * 1000);
    const g = ctx.createGain();
    g.gain.value = gain;
    let panner: PannerNode | null = null;
    if (pos) {
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 2.5;
      panner.maxDistance = 200;
      panner.rolloffFactor = 1.1;
      panner.positionX.value = pos.x;
      panner.positionY.value = pos.y;
      panner.positionZ.value = pos.z;
      g.connect(panner);
      panner.connect(this.sfxBus);
    } else g.connect(this.sfxBus);
    return { node: g, panner };
  }

  private env(g: GainNode, t: number, a: number, peak: number, dur: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  private osc(dest: AudioNode, type: OscillatorType, f0: number, f1: number, t: number, dur: number, peak: number, attack = 0.003) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, attack, peak, dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private noiseBurst(dest: AudioNode, type: BiquadFilterType, f0: number, f1: number, q: number, t: number, dur: number, peak: number, attack = 0.002, brown = false) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = brown ? this.brown : this.noise;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, attack, peak, dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private partials(dest: AudioNode, base: number, ratios: number[], decays: number[], t: number, peak: number) {
    ratios.forEach((r, i) => this.osc(dest, 'sine', base * r, base * r * 0.995, t, decays[i], peak / (i + 1), 0.002));
  }

  // ------------------------------------------------------------------ recipes
  punch(pos: Vec, power: number, heavy: boolean) {
    const o = this.out(pos, 0.5, 1, 2);
    if (!o) return;
    const t = this.ctx!.currentTime;
    const v = 0.5 + Math.min(power, 2) * 0.35;
    const p = 0.9 + Math.random() * 0.25;
    this.osc(o.node, 'sine', 150 * p, 48, t, 0.13 + power * 0.05, v * 0.9);
    this.noiseBurst(o.node, 'lowpass', 3200, 600, 0.7, t, 0.06, v * 0.55);
    this.noiseBurst(o.node, 'highpass', 3500, 3500, 0.7, t, 0.012, v * 0.3);
    if (heavy) {
      this.osc(this.shaper, 'sine', 95, 30, t, 0.32, v * 0.55);
      this.noiseBurst(o.node, 'bandpass', 1900, 900, 1.2, t, 0.1, v * 0.5);
      this.noiseBurst(o.node, 'highpass', 5000, 2500, 0.5, t + 0.005, 0.03, v * 0.4);
    }
  }

  kickHit(pos: Vec, power: number) {
    const o = this.out(pos, 0.5, 1, 2);
    if (!o) return;
    const t = this.ctx!.currentTime;
    const v = 0.6 + Math.min(power, 2) * 0.3;
    this.osc(o.node, 'sine', 120, 38, t, 0.22, v);
    this.noiseBurst(o.node, 'lowpass', 1500, 300, 0.8, t, 0.12, v * 0.6, 0.002, true);
    this.noiseBurst(o.node, 'bandpass', 2400, 1200, 1, t, 0.05, v * 0.35);
  }

  block(pos: Vec, perfect: boolean) {
    const o = this.out(pos, 0.4);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.osc(o.node, 'sine', 230, 130, t, 0.08, 0.5);
    this.noiseBurst(o.node, 'bandpass', 900, 600, 1.5, t, 0.06, 0.45);
    if (perfect) this.partials(o.node, 1400, [1, 2.4, 3.9], [0.5, 0.3, 0.2], t, 0.25);
  }

  whoosh(pos: Vec, heavy: boolean) {
    const o = this.out(pos, 0.4, 1, 0);
    if (!o) return;
    const t = this.ctx!.currentTime;
    const d = heavy ? 0.28 : 0.16;
    this.noiseBurst(o.node, 'bandpass', heavy ? 250 : 400, heavy ? 1300 : 2200, 1.2, t, d, heavy ? 0.5 : 0.28, d * 0.6);
  }

  footstep(pos: Vec, intensity: number) {
    const o = this.out(pos, 0.15, 1, 0);
    if (!o) return;
    const t = this.ctx!.currentTime;
    const v = 0.08 + intensity * 0.1;
    this.noiseBurst(o.node, 'bandpass', 1500 + Math.random() * 900, 900, 0.9, t, 0.045, v);
    this.osc(o.node, 'sine', 95, 60, t, 0.05, v * 0.6);
  }

  land(pos: Vec, speed: number) {
    const o = this.out(pos, 0.3, 1, 1);
    if (!o) return;
    const t = this.ctx!.currentTime;
    const v = Math.min(1, 0.2 + speed * 0.06);
    this.osc(o.node, 'sine', 110, 45, t, 0.12, v);
    this.noiseBurst(o.node, 'lowpass', 1200, 300, 0.7, t, 0.08, v * 0.5);
  }

  bodySlam(pos: Vec, speed: number) {
    const o = this.out(pos, 0.5, 1, 1);
    if (!o) return;
    const t = this.ctx!.currentTime;
    const v = Math.min(1.1, 0.3 + speed * 0.06);
    this.osc(o.node, 'sine', 85, 35, t, 0.25, v);
    this.noiseBurst(o.node, 'lowpass', 600, 150, 0.6, t, 0.18, v * 0.7, 0.002, true);
    this.noiseBurst(o.node, 'highpass', 2500, 1800, 0.6, t, 0.03, v * 0.3);
  }

  material(kind: string, pos: Vec, speed: number) {
    const o = this.out(pos, 1.2, 1, 0);
    if (!o) return;
    const t = this.ctx!.currentTime;
    const v = Math.min(1, 0.12 + speed * 0.055);
    const r = 0.9 + Math.random() * 0.2;
    switch (kind) {
      case 'metal':
      case 'gas':
        this.partials(o.node, 380 * r, [1, 2.76, 5.4, 8.93], [0.7, 0.45, 0.3, 0.18], t, v * 0.5);
        this.noiseBurst(o.node, 'highpass', 3000, 2000, 0.6, t, 0.03, v * 0.4);
        break;
      case 'pan':
        this.boing(pos, speed);
        break;
      case 'wood':
        this.noiseBurst(o.node, 'bandpass', 750 * r, 500, 4, t, 0.09, v * 0.9);
        this.osc(o.node, 'triangle', 240 * r, 150, t, 0.08, v * 0.5);
        break;
      case 'cardboard':
        this.noiseBurst(o.node, 'lowpass', 700, 250, 0.7, t, 0.1, v * 0.8);
        this.osc(o.node, 'sine', 130, 80, t, 0.07, v * 0.4);
        break;
      case 'plastic':
        this.osc(o.node, 'sine', 620 * r, 380, t, 0.06, v * 0.6);
        this.noiseBurst(o.node, 'bandpass', 1600, 1200, 3, t, 0.05, v * 0.5);
        break;
      case 'rubber':
        this.osc(o.node, 'sine', 210 * r, 130, t, 0.12, v * 0.8);
        this.osc(o.node, 'sine', 420 * r, 300, t, 0.08, v * 0.25);
        break;
      case 'stone':
        this.noiseBurst(o.node, 'lowpass', 900, 200, 0.8, t, 0.14, v, 0.002, true);
        this.osc(o.node, 'sine', 90, 50, t, 0.12, v * 0.6);
        break;
      case 'ceramic':
        this.partials(o.node, 2400 * r, [1, 1.52, 2.1], [0.18, 0.12, 0.08], t, v * 0.5);
        this.noiseBurst(o.node, 'highpass', 4000, 3000, 0.8, t, 0.04, v * 0.3);
        break;
      case 'squeak':
        this.squeak(pos);
        break;
      case 'bread':
        for (let i = 0; i < 5; i++) this.noiseBurst(o.node, 'highpass', 2500, 1500, 0.7, t + i * 0.018, 0.02, v * 0.35);
        break;
      case 'melon':
        this.osc(o.node, 'sine', 140, 70, t, 0.12, v * 0.8);
        this.noiseBurst(o.node, 'bandpass', 500, 300, 2, t, 0.1, v * 0.5);
        break;
      case 'flesh':
      case 'soft':
      default:
        this.osc(o.node, 'sine', 120, 60, t, 0.1, v * 0.7);
        this.noiseBurst(o.node, 'lowpass', 800, 300, 0.7, t, 0.06, v * 0.4);
    }
  }

  boing(pos: Vec, power = 8) {
    const o = this.out(pos, 1.3, 1, 2);
    if (!o) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const v = Math.min(1, 0.4 + power * 0.04);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(260, t + 0.08);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 17;
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(70, t);
    lg.gain.exponentialRampToValueAtTime(2, t + 0.9);
    lfo.connect(lg);
    lg.connect(osc.frequency);
    const g = ctx.createGain();
    this.env(g, t, 0.005, v, 1.0);
    osc.connect(g);
    g.connect(o.node);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 1.05);
    lfo.stop(t + 1.05);
    this.partials(o.node, 520, [1, 2.76, 5.4], [0.8, 0.5, 0.3], t, v * 0.35);
  }

  squeak(pos: Vec) {
    const o = this.out(pos, 0.4, 1, 1);
    if (!o) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    const r = 0.85 + Math.random() * 0.3;
    osc.frequency.setValueAtTime(800 * r, t);
    osc.frequency.exponentialRampToValueAtTime(1500 * r, t + 0.08);
    osc.frequency.exponentialRampToValueAtTime(650 * r, t + 0.26);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1300;
    f.Q.value = 2.5;
    const g = ctx.createGain();
    this.env(g, t, 0.01, 0.45, 0.28);
    osc.connect(f);
    f.connect(g);
    g.connect(o.node);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  splat(pos: Vec) {
    const o = this.out(pos, 0.6, 1, 2);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(o.node, 'lowpass', 2000, 250, 0.9, t, 0.3, 0.8);
    this.osc(o.node, 'sine', 110, 45, t, 0.18, 0.7);
    for (let i = 0; i < 4; i++) this.osc(o.node, 'sine', 300 + Math.random() * 400, 120, t + 0.05 + i * 0.04, 0.05, 0.2);
  }

  crash(pos: Vec, heavy: boolean) {
    const o = this.out(pos, 0.8, 1, 1);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(o.node, 'bandpass', 1400, 400, 0.9, t, heavy ? 0.4 : 0.25, 0.7);
    for (let i = 0; i < 6; i++) this.noiseBurst(o.node, 'bandpass', 900 + Math.random() * 2500, 600, 3, t + Math.random() * 0.15, 0.05, 0.35);
    this.osc(o.node, 'sine', 100, 40, t, 0.2, 0.5);
  }

  explosion(pos: Vec) {
    const o = this.out(pos, 2.5, 1.4, 3);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(o.node, 'lowpass', 2400, 120, 0.7, t, 1.6, 1.1, 0.005, true);
    this.noiseBurst(o.node, 'lowpass', 5000, 400, 0.5, t, 0.5, 0.7);
    this.osc(this.shaper, 'sine', 70, 22, t, 1.0, 0.9);
    for (let i = 0; i < 10; i++) this.noiseBurst(o.node, 'highpass', 2000, 1500, 0.8, t + 0.1 + Math.random() * 0.8, 0.03, 0.2);
  }

  /** Formant "voice" grunt. vowel: a e i o u */
  voice(pos: Vec, pitch: number, vowel: keyof typeof VOWELS, dur: number, gain = 0.5, bend = 0.85) {
    const o = this.out(pos, dur + 0.1, 1, 1);
    if (!o) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    const p = pitch * (0.92 + Math.random() * 0.16);
    src.frequency.setValueAtTime(p * 1.15, t);
    src.frequency.exponentialRampToValueAtTime(p * bend, t + dur);
    const vib = ctx.createOscillator();
    vib.frequency.value = 6 + Math.random() * 2;
    const vg = ctx.createGain();
    vg.gain.value = p * 0.03;
    vib.connect(vg);
    vg.connect(src.frequency);
    const g = ctx.createGain();
    this.env(g, t, 0.015, gain, dur);
    const [f1, f2, f3] = VOWELS[vowel];
    for (const [f, q, a] of [
      [f1, 7, 1],
      [f2, 9, 0.6],
      [f3, 10, 0.25],
    ] as const) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f * (0.95 + Math.random() * 0.1);
      bp.Q.value = q;
      const fg = ctx.createGain();
      fg.gain.value = a * 2.2;
      src.connect(bp);
      bp.connect(fg);
      fg.connect(g);
    }
    g.connect(o.node);
    src.start(t);
    vib.start(t);
    src.stop(t + dur + 0.05);
    vib.stop(t + dur + 0.05);
    // breath
    this.noiseBurst(o.node, 'bandpass', 1800, 1200, 1, t, dur * 0.6, gain * 0.12);
  }

  /** Gibberish speech for speech bubbles (Animal-Crossing style). */
  babble(pos: Vec, pitch: number, chars: number) {
    if (!this.ctx) return;
    const n = Math.min(12, Math.max(3, Math.round(chars / 3)));
    const vowels: (keyof typeof VOWELS)[] = ['a', 'e', 'i', 'o', 'u'];
    for (let i = 0; i < n; i++) {
      window.setTimeout(() => this.voice(pos, pitch * (1 + (Math.random() - 0.5) * 0.4), vowels[Math.floor(Math.random() * 5)], 0.07 + Math.random() * 0.05, 0.28, 1), i * 85);
    }
  }

  /** Long falling scream; returns a handle to move it with the body. */
  scream(pitch: number): Tracked | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    const t = ctx.currentTime;
    const dur = 3.2;
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 4;
    panner.rolloffFactor = 0.8;
    panner.connect(this.sfxBus);
    const g = ctx.createGain();
    this.env(g, t, 0.05, 0.75, dur);
    g.connect(panner);
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(pitch * 2.2, t);
    src.frequency.exponentialRampToValueAtTime(pitch * 1.2, t + dur);
    const vib = ctx.createOscillator();
    vib.frequency.value = 7;
    const vg = ctx.createGain();
    vg.gain.value = pitch * 0.08;
    vib.connect(vg);
    vg.connect(src.frequency);
    for (const [f, q, a] of [
      [850, 6, 1],
      [1250, 8, 0.7],
      [2700, 9, 0.3],
    ] as const) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const fg = ctx.createGain();
      fg.gain.value = a * 2.5;
      src.connect(bp);
      bp.connect(fg);
      fg.connect(g);
    }
    src.start(t);
    vib.start(t);
    src.stop(t + dur + 0.1);
    vib.stop(t + dur + 0.1);
    // cartoon bomb whistle
    this.osc(g, 'sine', 2200, 500, t + 0.2, 2.6, 0.25, 0.3);
    return new Tracked(panner, () => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    });
  }

  stunBirds(pos: Vec, dur = 3) {
    const o = this.out(pos, dur, 1, 1);
    if (!o) return;
    const t = this.ctx!.currentTime;
    for (let k = 0; k < dur / 0.22; k++) {
      const s = t + k * 0.22 + Math.random() * 0.05;
      const f = 2400 + Math.random() * 900;
      this.osc(o.node, 'sine', f, f * 1.35, s, 0.07, 0.12, 0.005);
      this.osc(o.node, 'sine', f * 1.3, f * 0.9, s + 0.08, 0.06, 0.08, 0.005);
    }
  }

  koTrombone(pos: Vec) {
    const o = this.out(pos, 2.4, 1, 3);
    if (!o) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const notes = [233, 220, 207, 196];
    notes.forEach((f, i) => {
      const s = t + i * 0.36;
      const d = i === 3 ? 1.0 : 0.32;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, s);
      if (i === 3) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 6;
        const lg = ctx.createGain();
        lg.gain.value = 6;
        lfo.connect(lg);
        lg.connect(osc.frequency);
        lfo.start(s);
        lfo.stop(s + d);
        osc.frequency.linearRampToValueAtTime(f * 0.94, s + d);
      }
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.setValueAtTime(500, s);
      flt.frequency.linearRampToValueAtTime(1400, s + 0.08);
      flt.frequency.linearRampToValueAtTime(700, s + d);
      flt.Q.value = 3;
      const g = ctx.createGain();
      this.env(g, s, 0.03, 0.32, d);
      osc.connect(flt);
      flt.connect(g);
      g.connect(o.node);
      osc.start(s);
      osc.stop(s + d + 0.05);
    });
  }

  bell(times = 1) {
    const o = this.out(null, 2, 1, 3);
    if (!o) return;
    const t = this.ctx!.currentTime;
    for (let i = 0; i < times; i++) this.partials(o.node, 980, [1, 2.0, 2.76, 4.07], [1.2, 0.8, 0.5, 0.3], t + i * 0.22, 0.45);
  }

  beep(high = false) {
    const o = this.out(null, 0.4, 1, 3);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.osc(o.node, 'square', high ? 1320 : 660, high ? 1320 : 660, t, high ? 0.45 : 0.16, 0.18, 0.005);
    if (high) this.partials(o.node, 220, [1, 1.5, 2.0, 3.0], [1.4, 1.0, 0.8, 0.5], t, 0.5);
  }

  click() {
    const o = this.out(null, 0.1, 1, 3);
    if (!o) return;
    const t = this.ctx!.currentTime;
    this.osc(o.node, 'sine', 1800, 1200, t, 0.03, 0.15);
  }

  fanfare(win: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = this.out(null, 3, 1, 3);
    if (!o) return;
    const t = ctx.currentTime;
    const seq = win
      ? [
          [523, 0, 0.14],
          [659, 0.15, 0.14],
          [784, 0.3, 0.14],
          [1047, 0.45, 0.7],
        ]
      : [
          [392, 0, 0.35],
          [370, 0.38, 0.35],
          [349, 0.76, 0.35],
          [330, 1.14, 1.1],
        ];
    for (const [f, d0, d] of seq) {
      for (const [type, det, a] of [
        ['sawtooth', 1, 0.16],
        ['square', 1.005, 0.08],
        ['sawtooth', 0.5, 0.08],
      ] as const) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = f * det;
        const flt = ctx.createBiquadFilter();
        flt.type = 'lowpass';
        flt.frequency.setValueAtTime(800, t + d0);
        flt.frequency.linearRampToValueAtTime(win ? 3500 : 1200, t + d0 + 0.05);
        const g = ctx.createGain();
        this.env(g, t + d0, 0.02, a, d);
        osc.connect(flt);
        flt.connect(g);
        g.connect(o.node);
        osc.start(t + d0);
        osc.stop(t + d0 + d + 0.05);
      }
    }
    if (win) for (const f of [523, 659, 784]) this.osc(o.node, 'triangle', f, f, t + 0.45, 1.2, 0.08, 0.01);
  }

  carAlarm(pos: Vec) {
    const o = this.out(pos, 3, 2.5, 2);
    if (!o) return;
    const t = this.ctx!.currentTime;
    for (let i = 0; i < 10; i++) this.osc(o.node, 'square', i % 2 ? 1000 : 760, i % 2 ? 1000 : 760, t + i * 0.25, 0.22, 0.2, 0.01);
  }

  // ------------------------------------------------------------------ ambience & music
  startAmbience() {
    const ctx = this.ctx;
    if (!ctx || this.ambienceStarted) return;
    this.ambienceStarted = true;
    // wind
    const wind = ctx.createBufferSource();
    wind.buffer = this.brown;
    wind.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'lowpass';
    wf.frequency.value = 500;
    const wg = ctx.createGain();
    wg.gain.value = 0.35;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lg = ctx.createGain();
    lg.gain.value = 260;
    lfo.connect(lg);
    lg.connect(wf.frequency);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.13;
    const lg2 = ctx.createGain();
    lg2.gain.value = 0.15;
    lfo2.connect(lg2);
    lg2.connect(wg.gain);
    wind.connect(wf);
    wf.connect(wg);
    wg.connect(this.ambBus);
    wind.start();
    lfo.start();
    lfo2.start();
    // city rumble
    const city = ctx.createBufferSource();
    city.buffer = this.brown;
    city.loop = true;
    city.playbackRate.value = 0.5;
    const cf = ctx.createBiquadFilter();
    cf.type = 'lowpass';
    cf.frequency.value = 180;
    const cg = ctx.createGain();
    cg.gain.value = 0.5;
    city.connect(cf);
    cf.connect(cg);
    cg.connect(this.ambBus);
    city.start();
    // distant horns & sirens
    const scheduleEvent = () => {
      if (!this.ctx) return;
      const r = Math.random();
      const pos = new THREE.Vector3((Math.random() - 0.5) * 300, -110, (Math.random() - 0.5) * 300);
      const o = this.out(pos, 3, 0.9, 0);
      if (o) {
        const t = ctx.currentTime;
        if (r < 0.55) {
          const f = 300 + Math.random() * 150;
          this.osc(o.node, 'square', f, f, t, 0.35, 0.05, 0.02);
          this.osc(o.node, 'square', f * 1.26, f * 1.26, t, 0.35, 0.04, 0.02);
        } else if (r < 0.8) {
          for (let i = 0; i < 4; i++) this.osc(o.node, 'sine', 700, 1300, t + i * 0.7, 0.35, 0.05, 0.05), this.osc(o.node, 'sine', 1300, 700, t + i * 0.7 + 0.35, 0.35, 0.05, 0.05);
        } else {
          // pigeons
          for (let i = 0; i < 3; i++) this.voice(new THREE.Vector3((Math.random() - 0.5) * 20, 2, (Math.random() - 0.5) * 20), 380, 'u', 0.25, 0.05, 0.8);
        }
      }
      window.setTimeout(scheduleEvent, 4000 + Math.random() * 9000);
    };
    window.setTimeout(scheduleEvent, 3000);
  }

  /** Procedural boom-bap loop. Called every frame; schedules ahead. */
  updateMusic() {
    const ctx = this.ctx;
    if (!ctx || !this.musicOn) return;
    const bpm = 96 + this.musicIntensity * 14;
    const stepDur = 60 / bpm / 4;
    if (this.nextNoteTime < ctx.currentTime) this.nextNoteTime = ctx.currentTime + 0.05;
    while (this.nextNoteTime < ctx.currentTime + 0.12) {
      this.playStep(this.musicStep, this.nextNoteTime, stepDur);
      this.nextNoteTime += stepDur;
      this.musicStep = (this.musicStep + 1) % 64;
    }
    this.musicTimer++;
  }

  private playStep(step: number, t: number, sd: number) {
    const ctx = this.ctx!;
    const bus = this.musicBus;
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const kick = [0, 7, 10].includes(s) || (s === 14 && bar % 2 === 1);
    const snare = s === 4 || s === 12;
    const hat = s % 2 === 0 || (this.musicIntensity > 0.5 && s % 2 === 1);
    if (kick) this.osc(bus, 'sine', 140, 42, t, 0.22, 0.9);
    if (snare) {
      this.noiseBurst(bus, 'bandpass', 2000, 1500, 0.8, t, 0.14, 0.45);
      this.osc(bus, 'triangle', 200, 160, t, 0.08, 0.3);
    }
    if (hat) this.noiseBurst(bus, 'highpass', 8000, 8000, 0.5, t, s % 4 === 2 ? 0.08 : 0.03, 0.12);
    // bass riff (E minor pentatonic)
    const roots = [41.2, 41.2, 55, 49];
    const riff = [0, -1, -1, 12, -1, -1, 0, -1, 3, -1, 5, -1, 7, -1, 5, 3];
    const n = riff[s];
    if (n >= 0) {
      const f = roots[bar % 4] * Math.pow(2, n / 12) * 2;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.setValueAtTime(1100, t);
      flt.frequency.exponentialRampToValueAtTime(180, t + sd * 1.6);
      flt.Q.value = 6;
      const g = ctx.createGain();
      this.env(g, t, 0.005, 0.35, sd * 1.8);
      o.connect(flt);
      flt.connect(g);
      g.connect(bus);
      o.start(t);
      o.stop(t + sd * 2);
    }
    // stab chords every other bar
    if (s === 0 && bar % 2 === 0) {
      const base = roots[bar % 4] * 8;
      for (const r of [1, 1.19, 1.5]) this.osc(bus, 'square', base * r, base * r, t, sd * 3, 0.04, 0.01);
    }
  }
}
