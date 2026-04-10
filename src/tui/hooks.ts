/**
 * React hooks for the TUI — useSyncExternalStore bridge + custom hooks.
 */
import { useSyncExternalStore, useCallback, useRef } from "react";
import type { Store } from "../store.js";
import type { AppState } from "../types.js";

export function useStore(store: Store<AppState>): AppState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useStoreSelector<T>(store: Store<AppState>, selector: (s: AppState) => T): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const getSnapshot = useCallback(() => selectorRef.current(store.getState()), [store]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
