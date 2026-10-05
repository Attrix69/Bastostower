/**
 * Tiny typed event bus. Systems communicate through events instead of holding
 * references to each other (combat → fx/audio/ui, rules → game flow, ...).
 */
export type Listener<T> = (payload: T) => void;

export class EventBus<Events extends { [K in keyof Events]: unknown }> {
  private map = new Map<keyof Events, Listener<any>[]>();

  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    let list = this.map.get(type);
    if (!list) {
      list = [];
      this.map.set(type, list);
    }
    list.push(fn);
    return () => this.off(type, fn);
  }

  off<K extends keyof Events>(type: K, fn: Listener<Events[K]>) {
    const list = this.map.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]) {
    const list = this.map.get(type);
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](payload);
  }
}
