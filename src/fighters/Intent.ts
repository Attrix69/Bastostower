/**
 * What a controller (human or AI) wants the fighter to do this step.
 * Both PlayerController and AIController write the same structure, so the
 * Fighter never knows (or cares) who is driving it.
 */
export class Btn {
  down = false;
  pressed = false;
  released = false;
  set(down: boolean) {
    if (down && !this.down) this.pressed = true;
    if (!down && this.down) this.released = true;
    this.down = down;
  }
  clearEdges() {
    this.pressed = false;
    this.released = false;
  }
}

export class Intent {
  /** local move: x = strafe right, z = forward. |v| <= 1 */
  moveX = 0;
  moveZ = 0;
  yaw = 0;
  pitch = 0;
  sprint = false;
  jump = false;
  readonly punchL = new Btn();
  readonly punchR = new Btn();
  readonly kick = new Btn();
  block = false;
  dodge = false;
  interact = false;
  /** button presses this step, used to escape grabs */
  mash = 0;

  clearEdges() {
    this.jump = false;
    this.dodge = false;
    this.interact = false;
    this.mash = 0;
    this.punchL.clearEdges();
    this.punchR.clearEdges();
    this.kick.clearEdges();
  }

  reset() {
    this.moveX = 0;
    this.moveZ = 0;
    this.sprint = false;
    this.block = false;
    this.punchL.set(false);
    this.punchR.set(false);
    this.kick.set(false);
    this.clearEdges();
  }
}
