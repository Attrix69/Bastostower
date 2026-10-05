/**
 * Fighter state machine definition.
 *
 * NORMAL → HIT → STUNNED → KO → GRABBED → CARRIED → THROWN → FALLING
 * plus GETTING_UP to come back from any ragdoll state.
 *
 * Each state declares what the fighter may do; the Fighter class enforces the
 * allowed transitions so nothing can get stuck (every non-terminal state has
 * a timer or a physical exit condition).
 */
export enum FState {
  Normal = 'NORMAL',
  Hit = 'HIT',
  Stunned = 'STUNNED',
  KO = 'KO',
  Grabbed = 'GRABBED',
  Carried = 'CARRIED',
  Thrown = 'THROWN',
  GettingUp = 'GETTING_UP',
  Falling = 'FALLING',
}

export interface StateRule {
  /** can steer movement */
  control: boolean;
  attack: boolean;
  block: boolean;
  interact: boolean;
  /** physics ragdoll drives the body */
  ragdoll: boolean;
  /** opponent may grab us */
  grabbable: boolean;
  moveScale: number;
  label: string;
}

export const RULES: Record<FState, StateRule> = {
  [FState.Normal]: { control: true, attack: true, block: true, interact: true, ragdoll: false, grabbable: false, moveScale: 1, label: 'EN FORME' },
  [FState.Hit]: { control: true, attack: false, block: true, interact: false, ragdoll: false, grabbable: false, moveScale: 0.35, label: 'TOUCHÉ' },
  [FState.Stunned]: { control: true, attack: false, block: false, interact: false, ragdoll: false, grabbable: true, moveScale: 0.5, label: 'ÉTOURDI' },
  [FState.KO]: { control: false, attack: false, block: false, interact: false, ragdoll: true, grabbable: true, moveScale: 0, label: 'ASSOMMÉ' },
  [FState.Grabbed]: { control: false, attack: false, block: false, interact: false, ragdoll: true, grabbable: false, moveScale: 0, label: 'SAISI' },
  [FState.Carried]: { control: false, attack: false, block: false, interact: false, ragdoll: true, grabbable: false, moveScale: 0, label: 'PORTÉ' },
  [FState.Thrown]: { control: false, attack: false, block: false, interact: false, ragdoll: true, grabbable: false, moveScale: 0, label: 'PROJETÉ' },
  [FState.GettingUp]: { control: false, attack: false, block: false, interact: false, ragdoll: false, grabbable: false, moveScale: 0, label: 'SE RELÈVE' },
  [FState.Falling]: { control: false, attack: false, block: false, interact: false, ragdoll: true, grabbable: false, moveScale: 0, label: 'CHUTE !' },
};

/** Allowed transitions (anything not listed is rejected). Falling is terminal. */
export const TRANSITIONS: Record<FState, FState[]> = {
  [FState.Normal]: [FState.Hit, FState.Stunned, FState.KO, FState.Thrown, FState.Falling, FState.Grabbed],
  [FState.Hit]: [FState.Normal, FState.Hit, FState.Stunned, FState.KO, FState.Thrown, FState.Falling],
  [FState.Stunned]: [FState.Normal, FState.KO, FState.Thrown, FState.Falling, FState.Grabbed, FState.Stunned],
  [FState.KO]: [FState.GettingUp, FState.Grabbed, FState.Thrown, FState.Falling, FState.KO],
  [FState.Grabbed]: [FState.Carried, FState.Thrown, FState.KO, FState.GettingUp, FState.Falling],
  [FState.Carried]: [FState.Thrown, FState.KO, FState.GettingUp, FState.Falling, FState.Grabbed],
  [FState.Thrown]: [FState.KO, FState.GettingUp, FState.Falling, FState.Thrown, FState.Grabbed],
  [FState.GettingUp]: [FState.Normal, FState.Thrown, FState.KO, FState.Falling, FState.Hit],
  [FState.Falling]: [],
};
