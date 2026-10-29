"use client";

import { useSyncExternalStore } from "react";
import {
  readCheckedFeatureFlags,
  subscribeToCheckedFeatureFlags,
} from "../lib/checked-feature-flags-store";

/** ISS-12048: the flag keys the current page checked, browser and server. */
export function useCheckedFeatureFlags(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeToCheckedFeatureFlags,
    readCheckedFeatureFlags,
    readNoCheckedFeatureFlags
  );
}

const NO_CHECKED_FEATURE_FLAGS: ReadonlySet<string> = new Set();

function readNoCheckedFeatureFlags(): ReadonlySet<string> {
  return NO_CHECKED_FEATURE_FLAGS;
}
