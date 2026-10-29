/**
 * ISS-12135: the base seed's Acme sessions are sent as a Desktop would send
 * them, so their branch pages carry cost, a trace, a pull request link and a
 * transcript like every corpus branch.
 */
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { desktopAgentSessionsPayloadObjectSchema } from "@/lib/desktop-agent-sessions-schema";
import { buildBatchPayload } from "../perf-import-desktop-snapshot";
import {
  ACME_SESSION_PLANS,
  acmeBranchWork,
} from "../vibe-seed/github/acme-branches";
import {
  acmeSessionTranscript,
  acmeWireSession,
} from "../vibe-seed/github/acme-session-wire";
import type { SeededBranch } from "../vibe-seed/github/seeded-branches";

const STARTED_AT = new Date("2026-10-05T08:00:00.000Z");
const IDENTITY = {
  externalSessionId: "seed-session-1",
  cwd: "/workspace/acme-web",
};

describe("acmeWireSession", () => {
  it.each(ACME_SESSION_PLANS.map((plan) => [plan.sessionName, plan] as const))(
    "sends %s with priced tokens, a tiling and its branch and pull request refs",
    (_name, plan) => {
      const work = acmeBranchWork(
        seededBranch(plan.branchName),
        plan,
        STARTED_AT
      );
      const session = acmeWireSession(plan, work, IDENTITY, STARTED_AT);

      const parsed = desktopAgentSessionsPayloadObjectSchema.parse(
        buildBatchPayload([session])
      );
      const [wire] = parsed.sessions;
      expect(wire?.externalSessionId).toBe(IDENTITY.externalSessionId);
      expect(wire?.name).toBe(plan.sessionName);
      expect(wire?.events.length).toBeGreaterThan(plan.commits.length * 2);
      expect(
        wire?.tokenEvents?.every((event) => (event.estimatedCostUsd ?? 0) > 0)
      ).toBe(true);
      expect(wire?.tokenUsageByModel[0]?.estimatedCostUsd).toBeGreaterThan(0);
      expect(wire?.activitySegmentRows?.length).toBeGreaterThan(0);
      const refs = wire?.artifactRefs ?? [];
      expect(
        refs.some(
          (ref) =>
            ref.kind === ArtifactRefTargetKind.Branch &&
            ref.relation === ArtifactRefRelation.Created &&
            ref.branchName === plan.branchName
        )
      ).toBe(true);
      expect(
        refs
          .filter((ref) => ref.kind === ArtifactRefTargetKind.PullRequest)
          .map((ref) => ref.prNumber)
      ).toEqual(plan.pullRequest === null ? [] : [plan.pullRequest.number]);
    }
  );

  it("bills every token event to the segment its turn opens", () => {
    for (const plan of ACME_SESSION_PLANS) {
      const work = acmeBranchWork(
        seededBranch(plan.branchName),
        plan,
        STARTED_AT
      );
      const [wire] = desktopAgentSessionsPayloadObjectSchema.parse(
        buildBatchPayload([acmeWireSession(plan, work, IDENTITY, STARTED_AT)])
      ).sessions;
      const segments = wire?.activitySegmentRows ?? [];
      for (const event of wire?.tokenEvents ?? []) {
        const at = Date.parse(event.createdAt);
        const billed = segments.filter(
          (segment) => segment.startMs <= at && at < segment.endMs
        );
        expect(billed, event.createdAt).toHaveLength(1);
        expect(billed[0]?.phase).not.toBe("idle");
      }
    }
  });

  it("is the same session on a rerun", () => {
    const [plan] = ACME_SESSION_PLANS;
    if (plan === undefined) {
      throw new Error("no Acme session plan");
    }
    const work = acmeBranchWork(
      seededBranch(plan.branchName),
      plan,
      STARTED_AT
    );
    expect(acmeWireSession(plan, work, IDENTITY, STARTED_AT)).toEqual(
      acmeWireSession(plan, work, IDENTITY, STARTED_AT)
    );
    expect(acmeSessionTranscript(plan, work, IDENTITY, STARTED_AT)).toBe(
      acmeSessionTranscript(plan, work, IDENTITY, STARTED_AT)
    );
  });
});

describe("acmeSessionTranscript", () => {
  it("opens with the plan's prompt and records every push the branch received", () => {
    for (const plan of ACME_SESSION_PLANS) {
      const work = acmeBranchWork(
        seededBranch(plan.branchName),
        plan,
        STARTED_AT
      );
      const lines = acmeSessionTranscript(plan, work, IDENTITY, STARTED_AT)
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));
      expect(lines[0]).toMatchObject({
        type: "user",
        sessionId: IDENTITY.externalSessionId,
        message: { role: "user", content: plan.prompt },
      });
      const commands = lines.flatMap((line) => toolCommands(line));
      expect(
        commands.filter((command) => command.startsWith("git push"))
      ).toHaveLength(work.pushes.length);
    }
  });
});

const toolUseLineSchema = z.object({
  message: z.object({
    content: z.array(
      z.union([
        z.object({ input: z.object({ command: z.string() }) }),
        z.unknown(),
      ])
    ),
  }),
});
const commandBlockSchema = z.object({
  input: z.object({ command: z.string() }),
});

function toolCommands(line: unknown): string[] {
  const parsed = toolUseLineSchema.safeParse(line);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.message.content.flatMap((block) => {
    const command = commandBlockSchema.safeParse(block);
    return command.success ? [command.data.input.command] : [];
  });
}

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
