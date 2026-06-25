import {
  DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE as sharedDesktopSignedLaunchManagedKeyErrorMessage,
  humanizeErrorCode as sharedHumanizeErrorCode,
  resolveFriendlyError as sharedResolveFriendlyError,
} from "@closedloop-ai/loops-api/friendly-error";

/** Exact managed-key launch failure message with first-class visible UI copy. */
export const DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE =
  sharedDesktopSignedLaunchManagedKeyErrorMessage;
export const humanizeErrorCode = sharedHumanizeErrorCode;
export const resolveFriendlyError = sharedResolveFriendlyError;
export type {
  FriendlyErrorDetails,
  FriendlyErrorInput,
  FriendlyErrorOutput,
} from "@closedloop-ai/loops-api/friendly-error";
