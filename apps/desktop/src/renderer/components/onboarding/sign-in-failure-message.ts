/**
 * Map a terminal browser sign-in failure reason to user-facing copy.
 *
 * Shared (ISS-5489) because two surfaces now start a loopback sign-in directly:
 * {@link DesktopOnboardingFlow}'s auth step, and the guest {@link AccountDialog},
 * whose "Sign Up" goes straight to the browser instead of opening a second
 * dialog. One copy source so the same failure cannot be worded two ways
 * depending on which door the person came through.
 *
 * Unknown and absent reasons both fall through to the generic line rather than
 * being surfaced raw — a newer main process can send a reason this build has
 * never heard of, and a raw enum is not something to show a user.
 */
export function signInFailureMessage(reason?: string): string {
  if (reason === "unavailable") {
    return "Sign-in isn't available on this build yet.";
  }
  if (reason === "already_in_progress") {
    return "A sign-in is already in progress.";
  }
  return "Sign-in didn't complete. Please try again.";
}
