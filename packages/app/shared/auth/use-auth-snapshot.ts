"use client";

import type { AuthSnapshot } from "./auth-adapter";
import { useAuthAdapter } from "./provider";

/**
 * Live auth snapshot for the current surface. The minimal identity surface
 * shared feature code may depend on; anything needing the full auth SDK is
 * shell-specific and stays in the app.
 */
export function useAuthSnapshot(): AuthSnapshot {
  return useAuthAdapter().useAuthSnapshot();
}
