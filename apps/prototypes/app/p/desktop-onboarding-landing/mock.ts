// Static landing copy kept out of the components so it reads as content, not
// layout. The landing is a single viewport: everything below the fold (the
// How/What sections and closing CTA) was removed per the PM decision
// 2026-08-04, so the hero carries the whole pitch. Value prop: nobody has a
// baseline for AI spend or quality; Closedloop provides one.

export const heroCopy = {
  eyebrow: "Welcome to Closedloop",
  title: "Know what",
  titleAccent: "good looks like.",
  subtitle:
    "Closedloop aggregates and benchmarks sessions so you know when you're being efficient or just burning tokens.",
  primaryCta: "Get started",
  signInPrompt: "Already have an account?",
  signInCta: "Sign in",
  // The local-first promise belongs on the first screen, under the CTA. This
  // desktop app's first act is reading local agent logs, so the reassurance
  // can't wait until the sign-up modal two steps later (PR #4368 review).
  privacyNote:
    "Your sessions stay on this Mac. Nothing uploads without permission.",
} as const;
