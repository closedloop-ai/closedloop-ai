import {
  GitHubConnectAction,
  type GitHubConnectPromptAction,
} from "./github-connect-action";

/**
 * What one connect action says. Constants only — no parsing, no component
 * imports — so a bundle-sensitive client can import a label without pulling the
 * resolver or a validator behind it.
 */
export type GitHubConnectCopy = {
  /** The control's verb. It must name the action the click performs. */
  ctaLabel: string;
  /** Why a gated metric is dark, in the same voice as the label. */
  gatedMetricExplanation: string;
  /**
   * Why the Insights Delivery SECTION is dark. Section-scoped, not card-scoped:
   * the page banner speaks for a whole row of tiles, and it sits beside the same
   * control, so it has to carry the same verb (ISS-5958 — it used to be a literal
   * at the call site and drifted the moment an action other than connect
   * existed).
   */
  deliveryBannerExplanation: string;
  /**
   * ISS-10645: the same ask made for a whole LIST rather than for one metric or
   * one KPI row — the Branches listing's stalled-load panel, where no card is on
   * screen for "this metric" to refer to.
   */
  listUnavailableExplanation: string;
  /**
   * The `card` placement's own verb, where the ISS-11476 reporter's `web-master`
   * dashboard prototype supplies one: it words a gated card's inline ask
   * "Connect to GitHub" — a link inside a sentence rather than the bare verb the
   * banner and centered placements sit beside their own copy with.
   *
   * OPTIONAL, and the omission is the point. The prototype draws only the
   * first-time connect state, so no human supplied a card wording for a repair;
   * an action without one falls back to its approved {@link ctaLabel} rather
   * than to a label this repo invented (tamsinb + Codex review on #8169,
   * AGENTS.md "Human Provenance for Product Behavior").
   */
  cardCtaLabel?: string;
  /**
   * The sentence that follows {@link cardCtaLabel} inline on a gated card, from
   * the same ISS-11476 prototype. It completes the CTA's sentence, so it opens
   * lowercase and is never read on its own. Optional for the same reason
   * {@link cardCtaLabel} is.
   */
  cardSupportingCopy?: string;
};

/**
 * The one copy map for GitHub connect controls (ISS-5958). A surface reads its
 * strings from here rather than spelling them at the call site, so the same
 * action cannot acquire a second wording.
 */
export const GITHUB_CONNECT_COPY: Record<
  GitHubConnectAction,
  GitHubConnectCopy
> = {
  // ISS-7866: SignUp deliberately SHARES Connect's verb. The
  // `pre-auth-desktop-onboarding` prototype draws the pre-auth dashboard with
  // "Connect GitHub" on every gated card while `signedIn` is false, because a
  // card is not where an account gets asked for — that ask lives at the scope
  // overlay and the post-tour dialog. Authorizing GitHub is genuinely what the
  // click does; creating the session is how that authorization is stored. Two
  // verbs for one wall is what shipped before, and it read as two different
  // problems.
  [GitHubConnectAction.SignUp]: {
    ctaLabel: "Connect GitHub",
    gatedMetricExplanation: "Connect GitHub to light up this metric.",
    deliveryBannerExplanation:
      "Connect GitHub to populate delivery metrics from cloud data.",
    listUnavailableExplanation: "Connect GitHub to load your branches.",
    cardCtaLabel: "Connect to GitHub",
    cardSupportingCopy: "to see sessions tied to PRs.",
  },
  [GitHubConnectAction.Connect]: {
    ctaLabel: "Connect GitHub",
    gatedMetricExplanation: "Connect GitHub to light up this metric.",
    deliveryBannerExplanation:
      "Connect GitHub to populate delivery metrics from cloud data.",
    listUnavailableExplanation: "Connect GitHub to load your branches.",
    cardCtaLabel: "Connect to GitHub",
    cardSupportingCopy: "to see sessions tied to PRs.",
  },
  [GitHubConnectAction.Reconnect]: {
    ctaLabel: "Reconnect GitHub",
    gatedMetricExplanation: "Reconnect GitHub to light up this metric.",
    deliveryBannerExplanation:
      "Reconnect GitHub to populate delivery metrics from cloud data.",
    listUnavailableExplanation: "Reconnect GitHub to load your branches.",
    // No card entries: the ISS-11476 prototype draws only the first-time connect
    // state, so a repair has no human-supplied card wording. It renders the
    // approved `ctaLabel` above instead of a phrase this repo would be writing
    // itself.
  },
};

/** The full-screen prompt's copy for one action. */
export type GitHubConnectPromptCopy = {
  /**
   * Small uppercase line above the heading, when the action has a flow position
   * worth naming. Optional: a repair has none, and the slot is styled
   * `text-primary`, a FILL token the design system keeps out of 12px text
   * (ISS-4793 — the reason `--link` exists).
   */
  eyebrow?: string;
  heading: string;
  /** What authorizing does, in one paragraph. */
  body: string;
  /**
   * The prompt's own button verb. It names a BROWSER HANDOFF, not the action —
   * the same word for every action, because the same thing happens on click. The
   * action is named by the eyebrow, heading, and body above it; the gated CTAs
   * elsewhere are where the verbs differ (ISS-5958 D2).
   */
  ctaLabel: string;
  /** The reassurance line under the button. */
  footnote: string;
};

/**
 * Copy for the canonical connect prompt, per action (ISS-5958 D2). Reconnect is
 * worded distinctly on purpose: a user whose grant expired is not setting
 * anything up, and "finish setup" reads to them as the app having lost work
 * they already did. The Connect wording is carried over verbatim from the
 * component — see `connect-github-prompt.tsx` for the two prior regressions
 * that make it worth leaving alone.
 */
export const GITHUB_CONNECT_PROMPT_COPY: Record<
  GitHubConnectPromptAction,
  GitHubConnectPromptCopy
> = {
  [GitHubConnectAction.Connect]: {
    eyebrow: "One more step · Required",
    heading: "Connect GitHub to finish setup",
    body: "Authorize Closedloop on GitHub so we can read your PR and repo activity through the GitHub API. Closedloop acts as you, and only reaches what you can already reach.",
    ctaLabel: "Continue with GitHub",
    footnote:
      "A per-user grant, no admin rights needed. Revocable anytime in GitHub.",
  },
  [GitHubConnectAction.Reconnect]: {
    // No eyebrow. The Connect variant's earns its line as a progress marker
    // ("One more step") in a flow that has steps; a repair has no position to
    // report, so the heading carries the situation alone. That also keeps this
    // state off the `text-primary` slot ISS-4793 warns against at 12px.
    heading: "Reconnect GitHub to restore your PR and repo activity",
    body: "Your GitHub authorization expired or was revoked, so Closedloop can no longer read your PR and repo activity. Authorize it again to restore them.",
    ctaLabel: "Continue with GitHub",
    footnote:
      "A per-user grant, no admin rights needed. Revocable anytime in GitHub.",
  },
};
