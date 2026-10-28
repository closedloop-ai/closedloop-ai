import { DesktopSignInFraming } from "@repo/api/src/types/desktop-authorize-url";

/**
 * ISS-5954 M4 — the desktop renderer's name for the sign-up vs sign-in framing.
 *
 * This module used to also derive the two framings' email CTA wording, for the
 * one surface that varied it: Settings → Account, a sign-IN door, against the
 * onboarding sign-UP doors. ISS-10246 deleted that tab with the rest of the
 * legacy Settings tree, leaving the shared guided-onboarding account step as
 * the only chooser on desktop — it labels its own CTA — so the derivation had
 * no caller left and went with it.
 *
 * Alias of the wire vocabulary, not a second const: the framing rides the
 * authorize URL (ISS-5954) so the web email landing branch can render the
 * matching Clerk embed, and two spellings of the same three-value set is the
 * drift this module exists to prevent.
 */
export const DesktopAuthFraming = DesktopSignInFraming;
export type DesktopAuthFraming = DesktopSignInFraming;
