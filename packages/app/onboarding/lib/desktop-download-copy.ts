/**
 * The approved words for the desktop-download offer, shared by every surface
 * that makes it (ISS-11261).
 *
 * Lifted out of `guided-onboarding-download-step.tsx`, where they were inline
 * literals, when the web dashboard's zero-session empty state needed the same
 * sentences. They are NOT re-authored here and must not be re-authored anywhere:
 * they were written for this job and root AGENTS.md Human Provenance reserves
 * user-visible words to a human.
 *
 * A lightweight, React-free and design-system-free module on purpose, like its
 * sibling `desktop-platform-availability.ts`: the dashboard's empty state needs
 * the sentence and not the wizard's step layout, phase source or skip
 * eligibility, and importing the step to reach a string would drag all three
 * into a `"use client"` bundle.
 */

/**
 * The wizard step's own title, and the title of the beat the reduced dashboard
 * tour rings the download card with (ISS-11261).
 *
 * It is NOT the empty card's heading — that stays `No agent sessions yet`, which
 * is what the card is about and what it ships today. This docstring claimed the
 * heading before the ISS-11261 review caught it (tamsinb): nothing outside the
 * wizard imported this constant, so the sentence described a change that had not
 * happened. Changing the heading is a copy decision the ticket never asked for,
 * so the claim was corrected rather than the card.
 */
export const DESKTOP_DOWNLOAD_TITLE = "Bring Closedloop to your desktop";

/** The wizard step's own eyebrow, and the reduced tour beat's (ISS-11261). */
export const DESKTOP_DOWNLOAD_EYEBROW = "Download the desktop app";

/**
 * What the offer says the app does, and why a reader wants it. The dashboard's
 * empty card takes it as its description, and the beat ringing that card takes
 * it as its body (ISS-11261).
 */
export const DESKTOP_DOWNLOAD_DESCRIPTION =
  "Closedloop automatically finds new Claude, Codex, and Cursor sessions and analyzes them locally as you work. Install Closedloop desktop to analyze your agentic coding sessions and share insights with your team.";
