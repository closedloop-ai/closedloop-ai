import type { DesktopAuthorizeParamError } from "./desktop-authorize-params";

/**
 * Pure state → copy mapping for the desktop authorize/consent page (FEA-2460),
 * mirroring {@link file://./desktop-connect-state.ts}. Framework-free so the
 * copy for every error path is unit-tested without rendering React; the
 * `"use client"` consent component consumes derived copy only (Humble Object).
 */

export type DesktopAuthorizeErrorCopy = {
  title: string;
  description: string;
  /** Whether the state offers a "Try again" affordance (transient failures). */
  retryable: boolean;
};

/** Copy for a link that failed to parse before consent (missing/bad params). */
export function getAuthorizeParamErrorCopy(
  reason: DesktopAuthorizeParamError
): DesktopAuthorizeErrorCopy {
  if (reason === "invalid_redirect_uri") {
    return {
      title: "Invalid device link",
      description:
        "This device link has an invalid return address. Reopen the sign-in from the desktop app.",
      retryable: false,
    };
  }
  return {
    title: "Incomplete device link",
    description:
      "This link is missing required information. Reopen the sign-in from the desktop app.",
    retryable: false,
  };
}

const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const BAD_REQUEST_STATUS = 400;

/**
 * Copy for a failed mint, keyed by HTTP status. A missing/non-HTTP status (e.g.
 * a network error or a malformed 2xx body) maps to the generic retryable copy.
 */
export function getAuthorizeMintErrorCopy(
  status: number | undefined
): DesktopAuthorizeErrorCopy {
  if (status === UNAUTHORIZED_STATUS) {
    return {
      title: "Session expired",
      description:
        "Your session ended before this device could be connected. Please sign in again.",
      retryable: false,
    };
  }
  if (status === FORBIDDEN_STATUS) {
    return {
      title: "Request blocked",
      description:
        "This request didn't come from a trusted origin and was blocked.",
      retryable: false,
    };
  }
  if (status === BAD_REQUEST_STATUS) {
    return {
      title: "Invalid device request",
      description:
        "This device request is invalid or has expired. Reopen the sign-in from the desktop app.",
      retryable: false,
    };
  }
  return {
    title: "Something went wrong",
    description: "We couldn't connect this device. Please try again.",
    retryable: true,
  };
}
