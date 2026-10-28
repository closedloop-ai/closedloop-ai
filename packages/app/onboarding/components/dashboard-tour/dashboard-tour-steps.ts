import { DashboardTourAnchor } from "../../../insights/components/overview/dashboard-tour-anchors";
import {
  DESKTOP_DOWNLOAD_DESCRIPTION,
  DESKTOP_DOWNLOAD_EYEBROW,
  DESKTOP_DOWNLOAD_TITLE,
} from "../../lib/desktop-download-copy";
import type { TourAnchoredStep } from "./dashboard-tour-types";

/**
 * The six canonical dashboard tour steps, in the order ISS-8351 names them:
 * headline metrics, AI impact, activity, sessions, models, pull requests.
 *
 * Copy is lifted from the normative Web Master v2 prototype
 * (`packages/app/shell/v2/components/web-master-preview/components/dashboard-spotlight-tour.tsx`).
 * ONLY the copy: that prototype spells its sixth target `pull-requests` and
 * queries a `data-dashboard-tour` attribute, and neither is normative. The
 * production anchor key is `prs` and the production attribute is `data-tour`,
 * so every `sel` here comes from {@link DashboardTourAnchor} rather than from a
 * literal — a step naming a key no shell emits would resolve to nothing at
 * `querySelector` and drop silently.
 *
 * Deliberately a CURATED subset of the anchor vocabulary, not an exhaustive map
 * over it: `agent-pipeline`, `autonomy`, `frustration` and `distribution` are
 * dashboard rows with anchors and no tour step, and a new dashboard row should
 * NOT automatically become a seventh stop on the tour. That is why there is no
 * totality guard here, unlike `ROW_TOUR_ANCHORS` next to the emitters.
 */
export const DASHBOARD_TOUR_STEPS: readonly TourAnchoredStep[] = [
  {
    sel: DashboardTourAnchor.Stats,
    eyebrow: "Your numbers",
    title: "Start with the headline metrics",
    body: "Sessions, AI spend, PRs shipped, PR size, and merged code update as more of your history is analyzed.",
  },
  {
    sel: DashboardTourAnchor.Impact,
    eyebrow: "AI impact",
    title: "Connect spend to shipped work",
    body: "See how model cost translates into pull requests, merged code, and the repositories where agents create the most value.",
  },
  {
    sel: DashboardTourAnchor.Activity,
    eyebrow: "Activity",
    title: "See when the work happens",
    body: "Each agent run and human input appears here, making working patterns and bursts of activity easy to spot.",
  },
  {
    sel: DashboardTourAnchor.Sessions,
    eyebrow: "Sessions",
    title: "Open any session for the full story",
    body: "Recent sessions show the harness, duration, and work performed. Open one to review the complete session trace.",
  },
  {
    sel: DashboardTourAnchor.Models,
    eyebrow: "Models",
    title: "Understand where model spend goes",
    body: "Track model cost over time and compare how Claude, Codex, and other models contribute to your work.",
  },
  {
    sel: DashboardTourAnchor.Prs,
    eyebrow: "Pull requests",
    title: "Track shipping velocity",
    body: "Follow merged pull requests over time to see whether changes to your agentic workflow are helping you ship faster.",
  },
];

/**
 * The run a brand-new org gets instead (ISS-9727): one beat, on the one thing a
 * zero-session dashboard has drawn, the card offering the Desktop download
 * (PLN-2216 R5).
 *
 * A SEPARATE LIST RATHER THAN A FILTERED {@link DASHBOARD_TOUR_STEPS}, because
 * the two runs are disjoint by construction and not by measurement. The empty
 * branch REPLACES the body, so a page carrying `getting-started` has drawn none
 * of the six rows above and a page carrying any of those six is not empty;
 * resolving one list against the page would answer correctly today and silently
 * merge the two runs the first time a row learns to render beside the empty
 * state.
 *
 * It stays one beat on purpose. The six above narrate data the reader has, and
 * there is none here — a longer run for an empty page could only be padded with
 * beats pointing at nothing, which is the lit-empty-step
 * `resolveDashboardTourSteps` exists to refuse.
 *
 * NO NEW WORDS. All three strings are the guided-onboarding `DownloadDesktop`
 * step's own, already human-approved for this exact offer, and imported from
 * {@link ../../lib/desktop-download-copy} rather than restated — root AGENTS.md
 * reserves user-visible words to a human, and the card underneath is drawn from
 * the same module, so the beat and the thing it rings cannot drift.
 */
export const REDUCED_DASHBOARD_TOUR_STEPS_DESKTOP_DOWNLOAD: readonly TourAnchoredStep[] =
  [
    {
      sel: DashboardTourAnchor.GettingStarted,
      eyebrow: DESKTOP_DOWNLOAD_EYEBROW,
      title: DESKTOP_DOWNLOAD_TITLE,
      body: DESKTOP_DOWNLOAD_DESCRIPTION,
    },
  ];
