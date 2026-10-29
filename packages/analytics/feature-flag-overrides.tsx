"use client";

import {
  FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
  isOverridableFeatureFlagKey,
  parseFeatureFlagOverrides,
} from "@repo/api/src/types/feature-flag-overrides";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { z } from "zod";

/**
 * A stored flag record: a boolean per flag key. The shape of both the E2E
 * fixture `client.ts` reads and the Dev Tools overrides below.
 */
export const featureFlagValueRecordSchema = z.record(z.string(), z.boolean());

export type FeatureFlagOverrides = Readonly<Record<string, boolean>>;

/**
 * Whether this browser's Dev Tools overrides apply (ISS-12048). The shell sets
 * it from Dev Mode: overrides win over PostHog while Dev Mode is on and have no
 * effect while it is off (operator decision, 2026-10-05). Defaults to inactive,
 * so a tree with no provider resolves every flag exactly as before.
 *
 * `onFlagRead` is told each key a read path checks, only while `active`, so the
 * overlay can list the flags the current page checked. It runs in an effect,
 * never during render, and is the shell's to supply.
 */
export function FeatureFlagOverridesProvider({
  active,
  onFlagRead,
  children,
}: {
  active: boolean;
  onFlagRead?: (flag: string) => (() => void) | undefined;
  children: ReactNode;
}) {
  const value = useMemo<FeatureFlagOverridesState>(
    () => ({ active, onFlagRead }),
    [active, onFlagRead]
  );
  return (
    <FeatureFlagOverridesContext.Provider value={value}>
      {children}
    </FeatureFlagOverridesContext.Provider>
  );
}

/**
 * The override for `flag`, or `undefined` when there is none or overrides are
 * not active. Every flag read path that honors overrides calls this one hook,
 * so the precedence, the restriction refusal and the read recording cannot
 * differ between them.
 */
export function useFeatureFlagOverride(flag: string): boolean | undefined {
  const { active, onFlagRead } = useContext(FeatureFlagOverridesContext);
  const overrides = useSyncExternalStore(
    active ? subscribeToOverrides : subscribeToNothing,
    active ? readOverrides : readNoOverrides,
    readNoOverrides
  );
  useLayoutEffect(() => {
    if (active) {
      return onFlagRead?.(flag);
    }
    return undefined;
  }, [active, onFlagRead, flag]);
  return resolveFeatureFlagOverride(active, overrides, flag);
}

/**
 * The precedence itself, pure so it can be pinned without a React tree.
 * `Object.hasOwn` rather than `overrides[flag]`, so a key such as `constructor`
 * cannot resolve through the prototype. A restriction flag is never
 * overridden, whatever storage holds (ISS-12048).
 */
export function resolveFeatureFlagOverride(
  active: boolean,
  overrides: FeatureFlagOverrides,
  flag: string
): boolean | undefined {
  if (
    !(
      active &&
      isOverridableFeatureFlagKey(flag) &&
      Object.hasOwn(overrides, flag)
    )
  ) {
    return undefined;
  }
  return overrides[flag];
}

const NO_OVERRIDES: FeatureFlagOverrides = Object.freeze({});

type FeatureFlagOverridesState = {
  active: boolean;
  onFlagRead?: (flag: string) => (() => void) | undefined;
};

const FeatureFlagOverridesContext = createContext<FeatureFlagOverridesState>({
  active: false,
});

let overridesCache: { raw: string | null; parsed: FeatureFlagOverrides } = {
  raw: null,
  parsed: NO_OVERRIDES,
};

function readNoOverrides(): FeatureFlagOverrides {
  return NO_OVERRIDES;
}

function subscribeToNothing(): () => void {
  return () => undefined;
}

/**
 * Snapshot of the stored overrides, cached on the raw string so the snapshot
 * identity is stable between writes (a `useSyncExternalStore` requirement).
 * Unreadable or malformed storage reads as "no overrides", never as a throw
 * during render.
 */
function readOverrides(): FeatureFlagOverrides {
  const raw = readRawOverrides();
  if (raw === overridesCache.raw) {
    return overridesCache.parsed;
  }
  overridesCache = { raw, parsed: parseOverrides(raw) };
  return overridesCache.parsed;
}

function readRawOverrides(): string | null {
  if (globalThis.window === undefined) {
    return null;
  }
  try {
    return globalThis.localStorage.getItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY);
  } catch {
    return null;
  }
}

function parseOverrides(raw: string | null): FeatureFlagOverrides {
  if (!raw) {
    return NO_OVERRIDES;
  }
  try {
    return parseFeatureFlagOverrides(JSON.parse(raw));
  } catch {
    return NO_OVERRIDES;
  }
}

/**
 * Re-reads on a `storage` event for the overrides key. The browser fires that
 * event in OTHER tabs; the writer in this tab (`useLocalStorageState` in
 * `@repo/app`) dispatches the same event on its own window, so one listener
 * covers both. A `null` key is `localStorage.clear()`, which removed it too.
 */
function subscribeToOverrides(onChange: () => void): () => void {
  if (typeof globalThis.addEventListener !== "function") {
    return () => undefined;
  }
  const handler = (event: StorageEvent) => {
    if (
      event.key === FEATURE_FLAG_OVERRIDES_STORAGE_KEY ||
      event.key === null
    ) {
      onChange();
    }
  };
  globalThis.addEventListener("storage", handler);
  return () => globalThis.removeEventListener("storage", handler);
}
