/**
 * Raw input layer: keyboard + mouse with pointer lock.
 * Exposes logical actions with edge detection (pressed/released) that are
 * consumed once per fixed simulation step, so no press is ever lost even when
 * the render rate is higher or lower than the simulation rate.
 */

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'sprint'
  | 'crouch'
  | 'punchL'
  | 'punchR'
  | 'kick'
  | 'block'
  | 'dodge'
  | 'interact'
  | 'pause'
  | 'restart';

const KEY_BINDINGS: Record<string, Action> = {
  KeyW: 'forward',
  KeyZ: 'forward', // AZERTY
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  KeyQ: 'block', // QWERTY. AZERTY remaps Q→left and A→block in mapKey().
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouch',
  KeyF: 'kick',
  KeyR: 'restart',
  KeyC: 'dodge',
  KeyE: 'interact',
  Escape: 'pause',
  KeyP: 'pause',
  Enter: 'restart',
};

export interface ButtonState {
  down: boolean;
  /** became down since last consume */
  pressed: boolean;
  /** became up since last consume */
  released: boolean;
  /** seconds held (sim time) */
  held: number;
}

export class Input {
  readonly buttons = new Map<Action, ButtonState>();
  mouseDX = 0;
  mouseDY = 0;
  locked = false;
  /** test/debug mode: accept input without pointer lock */
  allowUnlocked = false;
  sensitivity = 1;
  invertY = false;
  /** 'qwerty' uses WASD+Q, 'azerty' uses ZQSD + A for block */
  layout: 'qwerty' | 'azerty' = 'qwerty';
  /** layout guessed from the system (used when the setting is 'auto') */
  detectedLayout: 'qwerty' | 'azerty' = 'qwerty';
  onLayoutDetected: ((l: 'qwerty' | 'azerty') => void) | null = null;
  /** Count of key presses since last consume, used for "mash" escapes. */
  mashCount = 0;
  onPointerLockChange: ((locked: boolean) => void) | null = null;
  onAnyKey: ((code: string) => void) | null = null;

  private physicalDown = new Set<string>();
  private mouseDown = new Set<number>();

  constructor(private element: HTMLElement) {
    const all: Action[] = [
      'forward', 'back', 'left', 'right', 'jump', 'sprint', 'crouch', 'punchL', 'punchR', 'kick', 'block', 'dodge', 'interact', 'pause', 'restart',
    ];
    for (const a of all) this.buttons.set(a, { down: false, pressed: false, released: false, held: 0 });
    this.detectLayout();

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.releaseAll());
    element.addEventListener('mousedown', (e) => this.onMouse(e, true));
    window.addEventListener('mouseup', (e) => this.onMouse(e, false));
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked && !this.allowUnlocked) return;
      // Ignore absurd spikes some browsers emit when (re)locking.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    // some embeddings (sandboxed iframes...) refuse pointer lock: fall back to plain mouse input
    document.addEventListener('pointerlockerror', () => {
      this.allowUnlocked = true;
      this.onPointerLockChange?.(true);
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked && !this.allowUnlocked) this.releaseAll();
      this.onPointerLockChange?.(this.locked);
    });
  }

  private async detectLayout() {
    // Keyboard Map API (Chromium). Falls back to qwerty; the menu exposes a toggle.
    const kb = (navigator as any).keyboard;
    if (kb?.getLayoutMap) {
      try {
        const map = await kb.getLayoutMap();
        if (map.get('KeyQ') === 'a') this.detectedLayout = 'azerty';
        this.onLayoutDetected?.(this.detectedLayout);
      } catch {
        /* ignore */
      }
    } else if (/^fr\b/i.test(navigator.language)) {
      this.detectedLayout = 'azerty';
      this.onLayoutDetected?.(this.detectedLayout);
    }
  }

  requestLock() {
    const el = this.element as any;
    try {
      const p = el.requestPointerLock?.({ unadjustedMovement: true });
      if (p && typeof p.catch === 'function') p.catch(() => el.requestPointerLock?.());
    } catch {
      el.requestPointerLock?.();
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private mapKey(code: string): Action | undefined {
    if (this.layout === 'azerty') {
      if (code === 'KeyQ') return 'left';
      if (code === 'KeyA') return 'block';
      if (code === 'KeyW') return undefined;
    } else {
      if (code === 'KeyZ') return undefined;
    }
    return KEY_BINDINGS[code];
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (e.repeat) return;
    const action = this.mapKey(e.code);
    if (down) this.onAnyKey?.(e.code);
    if (down && (this.locked || this.allowUnlocked)) this.mashCount++;
    if (!action) return;
    if (this.locked || action === 'pause' || action === 'restart') e.preventDefault();
    if (down) this.physicalDown.add(e.code);
    else this.physicalDown.delete(e.code);
    this.setAction(action, this.isActionPhysicallyDown(action));
  }

  private onMouse(e: MouseEvent, down: boolean) {
    if (!this.locked && !this.allowUnlocked) return;
    const action: Action | undefined = e.button === 0 ? 'punchL' : e.button === 2 ? 'punchR' : e.button === 1 || e.button === 3 ? 'kick' : e.button === 4 ? 'block' : undefined;
    if (down) this.mouseDown.add(e.button);
    else this.mouseDown.delete(e.button);
    if (down) this.mashCount++;
    if (action) this.setAction(action, down || this.isActionPhysicallyDown(action));
  }

  private isActionPhysicallyDown(action: Action) {
    for (const code of this.physicalDown) if (this.mapKey(code) === action) return true;
    return false;
  }

  private setAction(action: Action, down: boolean) {
    const b = this.buttons.get(action)!;
    if (down && !b.down) {
      b.pressed = true;
      b.held = 0;
    }
    if (!down && b.down) b.released = true;
    b.down = down;
  }

  releaseAll() {
    this.physicalDown.clear();
    this.mouseDown.clear();
    for (const b of this.buttons.values()) {
      if (b.down) b.released = true;
      b.down = false;
    }
  }

  get(action: Action) {
    return this.buttons.get(action)!;
  }

  /** Call once per fixed step after reading button edges. */
  endStep(dt: number) {
    for (const b of this.buttons.values()) {
      b.pressed = false;
      b.released = false;
      if (b.down) b.held += dt;
    }
    this.mashCount = 0;
  }

  /** Read and reset accumulated mouse delta (called at render rate for zero-latency look). */
  consumeMouse(): [number, number] {
    const dx = this.mouseDX;
    const dy = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return [dx, dy];
  }
}
