import type { EventBus } from '../core/EventBus';
import type { Loop } from '../core/Loop';
import type { Physics } from '../physics/Physics';
import type { Arena } from '../world/Arena';
import type { Fighter } from '../fighters/Fighter';
import type { PropSystem } from '../props/PropSystem';
import type { GameEvents } from './events';

/** Shared references handed to gameplay systems (avoids a web of constructor args). */
export interface GameContext {
  physics: Physics;
  arena: Arena;
  events: EventBus<GameEvents>;
  loop: Loop;
  fighters: Fighter[];
  props: PropSystem;
  /** scaled game time in seconds */
  readonly time: number;
  /** match is live (fighters may act) */
  readonly live: boolean;
}
