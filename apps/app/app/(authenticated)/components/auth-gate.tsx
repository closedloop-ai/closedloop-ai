"use client";

import { useAuth } from "@repo/auth/client";
import type { ReactNode } from "react";

type AuthGateProps = {
  readonly children: ReactNode;
};

/**
 * Gates child rendering on Clerk's client-side auth being fully loaded.
 *
 * Without this, TanStack Query hooks fire before `getToken()` is ready,
 * causing 401s on the first render after login (e.g. dashboard stats).
 * By deferring children until `isLoaded`, we guarantee `getToken()` will
 * return a valid token for all downstream API calls.
 */
export function AuthGate({ children }: AuthGateProps) {
  const { isLoaded } = useAuth();

  if (!isLoaded) {
    return null;
  }

  return children;
}
