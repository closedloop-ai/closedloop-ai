/**
 * The guided-onboarding welcome step's two CTA labels.
 *
 * Deliberately a zero-dependency constants module rather than an export off
 * `guided-onboarding-welcome-step.tsx`: the desktop Playwright specs assert
 * these labels and run in Node, where importing a `"use client"` component
 * pulls a React runtime they cannot load. Hanging the strings off the component
 * left every spec re-typing the literal, which is how the two drift.
 */

/** The Desktop welcome CTA. */
export const DESKTOP_WELCOME_CTA_LABEL = "Start Analyzing My Sessions";

/** The Web welcome CTA, which opens account setup. */
export const WEB_WELCOME_CTA_LABEL = "Get Started";
