import { relabelGoldenUsers } from "../core/org-people";
import type { VibeSeedStage } from "../stage";
import { STAGES as coreStages } from "./core";
import { STAGES as deliveryStages } from "./delivery";
import { STAGES as derivedStages } from "./derived";
import { STAGES as desktopAuthStages } from "./desktop-auth";
import { STAGES as desktopSyncStages } from "./desktop-sync";
import { STAGES as domainStages } from "./domain";
import { STAGES as githubStages } from "./github";

/**
 * Run order: core org setup, then everything the golden Desktop store feeds
 * through the sync producers, then web-only domain rows, then GitHub-derived branch and comment rows, then delivery points (which
 * match the pull requests the GitHub stage completes), then the backfills
 * and rollups that derive from all of the above, and last the desktop session
 * the vibe Desktop profile signs in with.
 */
export const VIBE_SEED_STAGES: readonly VibeSeedStage[] = [
  ...coreStages,
  ...desktopSyncStages,
  ...domainStages,
  ...githubStages,
  {
    name: "relabel-golden-users",
    models: [],
    run: relabelGoldenUsers,
  },
  ...deliveryStages,
  ...derivedStages,
  ...desktopAuthStages,
];
