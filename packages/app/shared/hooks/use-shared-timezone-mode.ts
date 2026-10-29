"use client";

import { useCallback } from "react";
import { z } from "zod";
import { useFeatureFlagGateOptional } from "../feature-flags/use-feature-flag-enabled";
import {
  DEFAULT_TIMEZONE_MODE,
  TIMEZONE_MODES,
  type TimezoneMode,
} from "../lib/date-window-timezone-mode";
import { SESSIONS_BRANCHES_TIMEZONE_MODE_FEATURE_FLAG_KEY } from "../lib/feature-flags";
import { useLocalStorageState } from "./use-local-storage-state";

const modeSchema = z.enum(TIMEZONE_MODES);

function storageKey(surface: string): string {
  return `shared:timezone-mode:${surface}`;
}

/**
 * The reader's chosen day boundary, and the writer for it — or a window pinned
 * to UTC with no writer at all.
 *
 * The two shapes are the whole point. This is the ONE read site for
 * {@link SESSIONS_BRANCHES_TIMEZONE_MODE_FEATURE_FLAG_KEY}, and the flag picks
 * between them rather than being handed onward as a boolean: a closed gate
 * returns the UTC mode and NO setter, so a toolbar renders no control (it gates
 * on the setter's presence, the same way it gates the Custom window control) and
 * a host computes the window it computes today.
 *
 * That also closes the hazard a persisted preference would otherwise open. The
 * choice is stored per surface, so a reader who picks Local keeps it; but if the
 * gate is later shut, the stored value is not consulted and the window returns
 * to UTC. A reader can never be left on a Local window with no control on screen
 * to see or clear it — the same rule the explicit `?from=`/`?to=` window follows.
 */
export type SharedTimezoneModeState = {
  timezoneMode: TimezoneMode;
  /** Absent while the gate is shut — there is no control and no way to move. */
  setTimezoneMode: ((mode: TimezoneMode) => void) | undefined;
  /**
   * Whether the mode above is safe to KEY A DATA READ off yet (whitlockk + codex
   * review).
   *
   * PostHog reports an unresolved assignment as `false`, which is
   * indistinguishable from a real "off" — so a returning reader whose stored
   * mode is `local` would have the mode read UTC for the first render, key the
   * list and summary requests to UTC bounds, and then flip to Local and refetch
   * once the assignment landed: a transiently wrong population plus a duplicate
   * read, on both halves of the surface. Each host folds this into the existing
   * `enabled` gate on its list read, exactly as it already does for
   * `grid-table-v2` and the custom-window flag. `FEATURE_FLAG_RESOLUTION_DEADLINE_MS`
   * bounds the wait, so a flag-service outage still degrades to the UTC window
   * rather than to a permanent skeleton.
   */
  isTimezoneModeReady: boolean;
};

export function useSharedTimezoneMode(
  surface: string
): SharedTimezoneModeState {
  // `Optional` because both filter bars also mount in Storybook and in
  // mini-table tests, where no feature-flag provider exists; there the gate
  // reads shut — and READY — rather than crashing the subtree.
  const gate = useFeatureFlagGateOptional(
    SESSIONS_BRANCHES_TIMEZONE_MODE_FEATURE_FLAG_KEY
  );
  const [raw, setRaw] = useLocalStorageState<string>(
    storageKey(surface),
    DEFAULT_TIMEZONE_MODE
  );
  const setTimezoneMode = useCallback(
    (mode: TimezoneMode) => setRaw(mode),
    [setRaw]
  );

  if (!gate.enabled) {
    return {
      timezoneMode: DEFAULT_TIMEZONE_MODE,
      setTimezoneMode: undefined,
      isTimezoneModeReady: gate.isReady,
    };
  }
  const parsed = modeSchema.safeParse(raw);
  return {
    timezoneMode: parsed.success ? parsed.data : DEFAULT_TIMEZONE_MODE,
    setTimezoneMode,
    isTimezoneModeReady: gate.isReady,
  };
}
