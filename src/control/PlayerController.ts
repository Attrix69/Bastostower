import type { Input } from '../core/Input';
import type { Fighter } from '../fighters/Fighter';
import { clamp } from '../core/math';

/**
 * Human input → Intent. Mouse look is applied at render rate (zero latency);
 * buttons are sampled once per fixed step with edge detection.
 */
export class PlayerController {
  yaw = 0;
  pitch = 0;
  sensitivity = 1;
  invertY = false;

  constructor(
    private input: Input,
    readonly fighter: Fighter,
  ) {}

  reset(yaw: number) {
    this.yaw = yaw;
    this.pitch = 0;
  }

  look(dx: number, dy: number) {
    const k = 0.0021 * this.sensitivity;
    this.yaw -= dx * k;
    this.pitch -= dy * k * (this.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -1.45, 1.4);
  }

  update(enabled: boolean) {
    const it = this.fighter.intent;
    it.clearEdges();
    const inp = this.input;
    if (!enabled) {
      it.reset();
      it.yaw = this.yaw;
      it.pitch = this.pitch;
      return;
    }
    const b = (a: Parameters<Input['get']>[0]) => inp.get(a);
    it.moveX = (b('right').down ? 1 : 0) - (b('left').down ? 1 : 0);
    it.moveZ = (b('forward').down ? 1 : 0) - (b('back').down ? 1 : 0);
    it.sprint = b('sprint').down;
    it.jump = b('jump').pressed;
    it.block = b('block').down;
    it.dodge = b('dodge').pressed;
    it.interact = b('interact').pressed;
    for (const [src, dst] of [
      [b('punchL'), it.punchL],
      [b('punchR'), it.punchR],
      [b('kick'), it.kick],
    ] as const) {
      // keep presses that were released within the same step (fast clicks)
      if (src.pressed) dst.pressed = true;
      if (src.released) dst.released = true;
      dst.down = src.down;
    }
    it.mash = inp.mashCount;
    it.yaw = this.yaw;
    it.pitch = this.pitch;
  }
}
