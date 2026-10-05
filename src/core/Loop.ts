/**
 * Fixed-timestep game loop.
 *
 * The simulation always advances in ticks of 1/60 s of *real* time, but each
 * tick integrates `TICK * timeScale` of *game* time. This keeps slow-motion
 * and hit-stop perfectly smooth (physics keeps stepping 60x/s with smaller dt)
 * instead of the choppy look you get from simply skipping steps.
 */
export const TICK = 1 / 60;

export class Loop {
  timeScale = 1;
  /** Game-time scale requested by gameplay (slow-mo). Combined with hitstop. */
  private slowmoScale = 1;
  private slowmoTimer = 0;
  private slowmoTarget = 1;
  private hitstopTimer = 0;
  private hitstopScale = 0.05;

  private acc = 0;
  private last = 0;
  private running = false;
  private rafId = 0;
  /** total game time elapsed (scaled) */
  gameTime = 0;
  /** real time elapsed */
  realTime = 0;
  /** frame time stats for dynamic resolution */
  frameMs = 16.7;

  constructor(
    private fixedUpdate: (dt: number, realDt: number) => void,
    private render: (alpha: number, realDt: number) => void,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(frame);
      let realDt = (now - this.last) / 1000;
      this.last = now;
      this.frameMs += (realDt * 1000 - this.frameMs) * 0.05;
      // Avoid spiral of death after tab switches / hitches.
      if (realDt > 0.1) realDt = 0.1;
      this.realTime += realDt;
      this.acc += realDt;
      let steps = 0;
      while (this.acc >= TICK && steps < 5) {
        this.updateTimeScale(TICK);
        const dt = TICK * this.timeScale;
        this.gameTime += dt;
        this.fixedUpdate(dt, TICK);
        this.acc -= TICK;
        steps++;
      }
      if (steps === 5) this.acc = 0;
      this.render(this.acc / TICK, realDt);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Freeze-frame on impact. Longer hits override shorter ones. */
  hitstop(seconds: number, scale = 0.04) {
    if (seconds > this.hitstopTimer) {
      this.hitstopTimer = seconds;
      this.hitstopScale = scale;
    }
  }

  /** Smoothly enter slow motion for `seconds` of real time. */
  slowmo(scale: number, seconds: number) {
    this.slowmoTarget = scale;
    this.slowmoTimer = seconds;
  }

  clearTimeEffects() {
    this.slowmoTarget = 1;
    this.slowmoScale = 1;
    this.slowmoTimer = 0;
    this.hitstopTimer = 0;
    this.timeScale = 1;
  }

  private updateTimeScale(realDt: number) {
    if (this.slowmoTimer > 0) {
      this.slowmoTimer -= realDt;
      if (this.slowmoTimer <= 0) this.slowmoTarget = 1;
    }
    // ease in/out of slow motion
    const k = this.slowmoTarget < this.slowmoScale ? 18 : 3.5;
    this.slowmoScale += (this.slowmoTarget - this.slowmoScale) * (1 - Math.exp(-k * realDt));
    let s = this.slowmoScale;
    if (this.hitstopTimer > 0) {
      this.hitstopTimer -= realDt;
      s = Math.min(s, this.hitstopScale);
    }
    this.timeScale = s;
  }
}
