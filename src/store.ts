/**
 * Lightweight reactive store — ~35 lines, compatible with React useSyncExternalStore.
 * Inspired by Claude Code's custom Store.
 */
export interface Store<T> {
  getState(): T;
  setState(updater: (prev: T) => T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState() {
      return state;
    },
    setState(updater) {
      const next = updater(state);
      if (next !== state) {
        state = next;
        for (const fn of listeners) fn();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
