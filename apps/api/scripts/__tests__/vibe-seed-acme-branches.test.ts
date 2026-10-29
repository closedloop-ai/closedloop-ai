/**
 * ISS-12135: the Acme branches' replay keeps its clock across reruns, so a
 * second run delivers the same commits at the same instants.
 */
import { describe, expect, it } from "vitest";
import {
  ACME_SESSION_PLANS,
  acmeBranchWork,
  acmeSessionStart,
} from "../vibe-seed/github/acme-branches";
import type { SeededBranch } from "../vibe-seed/github/seeded-branches";
import { COMMON_BRANCH_PREFIXES } from "../vibe-seed/github/store-work";

const FIRST_NOW = new Date("2026-10-07T03:00:00.000Z");
const RERUN_NOW = new Date("2026-10-08T15:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function seededBranch(branchName: string): SeededBranch {
  return {
    artifactId: "branch-1",
    projectId: null,
    repositoryId: "repository-1",
    repositoryGitHubId: 731_264_058,
    repositoryFullName: "acme-co/acme-web",
    branchName,
    currentPullRequestDetailId: null,
    pullRequestIdsByNumber: new Map(),
  };
}

describe("Acme branch names", () => {
  it("prefix the signed-in person's branches with a branch kind, never a personal handle", () => {
    for (const plan of ACME_SESSION_PLANS) {
      const work = acmeBranchWork(
        seededBranch(plan.branchName),
        plan,
        FIRST_NOW
      );
      const [prefix = ""] = plan.branchName.split("/");
      expect(prefix, plan.branchName).not.toBe(work.author.login);
      expect(COMMON_BRANCH_PREFIXES.has(prefix), plan.branchName).toBe(true);
    }
  });
});

describe("Acme branch replay clock", () => {
  it("dates a first run from now and a rerun from the session the first run dated", () => {
    for (const plan of ACME_SESSION_PLANS) {
      const first = acmeSessionStart(plan, FIRST_NOW, null);
      expect(first.getTime()).toBe(
        FIRST_NOW.getTime() - plan.startedHoursAgo * HOUR_MS
      );
      expect(acmeSessionStart(plan, RERUN_NOW, first)).toStrictEqual(first);
    }
  });

  it("replays the same commits at the same instants for the same start", () => {
    for (const plan of ACME_SESSION_PLANS) {
      const branch = seededBranch(plan.branchName);
      const start = acmeSessionStart(plan, FIRST_NOW, null);
      const rerunStart = acmeSessionStart(plan, RERUN_NOW, start);
      expect(acmeBranchWork(branch, plan, rerunStart)).toStrictEqual(
        acmeBranchWork(branch, plan, start)
      );
      expect(
        acmeBranchWork(branch, plan, start).pushes.every(
          (push) => push.at.getTime() < FIRST_NOW.getTime()
        )
      ).toBe(true);
    }
  });
});
