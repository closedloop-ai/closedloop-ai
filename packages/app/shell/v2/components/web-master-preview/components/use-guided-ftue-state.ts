"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  createInitialGuidedFtueState,
  type GuidedFtueState,
  getGuidedFtueStorageKey,
  readGuidedFtueState,
  removeGuidedFtueState,
  writeGuidedFtueState,
} from "./guided-ftue-state";
import type { PrototypeMode } from "./prototype-developer-menu";

export function useGuidedFtueState({
  mode,
  organizationMemberCount,
}: {
  mode: PrototypeMode;
  organizationMemberCount: number;
}): {
  ready: boolean;
  reset: () => void;
  setState: Dispatch<SetStateAction<GuidedFtueState>>;
  state: GuidedFtueState;
} {
  const storageKey = useMemo(
    () => getGuidedFtueStorageKey(mode, organizationMemberCount),
    [mode, organizationMemberCount]
  );
  const [state, setState] = useState(createInitialGuidedFtueState);
  const [loadedStorageKey, setLoadedStorageKey] = useState<string | null>(null);

  useEffect(() => {
    const storage = getBrowserStorage();
    const restored = storage ? readGuidedFtueState(storage, storageKey) : null;
    setState(restored ?? createInitialGuidedFtueState());
    setLoadedStorageKey(storageKey);
  }, [storageKey]);

  useEffect(() => {
    const storage = getBrowserStorage();
    if (storage && loadedStorageKey === storageKey) {
      writeGuidedFtueState(storage, storageKey, state);
    }
  }, [loadedStorageKey, state, storageKey]);

  const reset = useCallback(() => {
    const storage = getBrowserStorage();
    if (storage) {
      removeGuidedFtueState(storage, storageKey);
    }
    setState(createInitialGuidedFtueState());
    setLoadedStorageKey(storageKey);
  }, [storageKey]);

  return {
    ready: loadedStorageKey === storageKey,
    reset,
    setState,
    state,
  };
}

function getBrowserStorage(): Storage | null {
  try {
    return globalThis.window.localStorage;
  } catch {
    return null;
  }
}
