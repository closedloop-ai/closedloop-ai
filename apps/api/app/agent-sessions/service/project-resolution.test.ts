/**
 * FEA-1749 Phase 4 — `resolveProjectId` attributes a synced session to a project
 * ONLY through real lineage.
 *
 * The removed third path inferred a project from the session's repository, via
 * repository -> teamRepositories -> team.projects, resolving whenever the set
 * happened to contain exactly one project. That relationship does not exist in
 * the domain: a project may nominate default repositories for agentic execution,
 * but that does not make a repository belong to a project. The inference was not
 * merely unsound in theory — `projectIds.size === 1` meant a session's project
 * silently changed the moment someone added a second project to the team.
 *
 * These are pure-function tests: no DB, no mocks. The maps ARE the resolution.
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { describe, expect, it, vi } from "vitest";
import {
  resolveProjectId,
  resolveProjectResolution,
} from "./project-resolution";
import type { AgentSessionUpsertTx, SessionProjectResolution } from "./records";

const ARTIFACT_ID = "019f66f7-0804-7737-834f-900403b6f6ea";
const LOOP_ID = "019f672d-f39d-72ee-9479-f67bed4a18c4";
const PROJECT_FROM_ARTIFACT = "project-from-artifact";
const PROJECT_FROM_LOOP = "project-from-loop";

function makeSession(
  attribution: SyncedAgentSession["attribution"]
): SyncedAgentSession {
  return { attribution } as SyncedAgentSession;
}

function makeResolution(
  overrides: Partial<SessionProjectResolution> = {}
): SessionProjectResolution {
  return {
    artifactProjectById: new Map([[ARTIFACT_ID, PROJECT_FROM_ARTIFACT]]),
    loopProjectById: new Map([[LOOP_ID, PROJECT_FROM_LOOP]]),
    sameOrgLoopIds: new Set([LOOP_ID]),
    ...overrides,
  };
}

describe("resolveProjectId", () => {
  it("resolves via sourceArtifactId lineage", () => {
    const session = makeSession({ sourceArtifactId: ARTIFACT_ID });

    expect(resolveProjectId(session, makeResolution())).toBe(
      PROJECT_FROM_ARTIFACT
    );
  });

  it("resolves via sourceLoopId lineage", () => {
    const session = makeSession({ sourceLoopId: LOOP_ID });

    expect(resolveProjectId(session, makeResolution())).toBe(PROJECT_FROM_LOOP);
  });

  it("prefers the source artifact over the loop when both are present", () => {
    const session = makeSession({
      sourceArtifactId: ARTIFACT_ID,
      sourceLoopId: LOOP_ID,
    });

    expect(resolveProjectId(session, makeResolution())).toBe(
      PROJECT_FROM_ARTIFACT
    );
  });

  it("returns null for repository-only attribution (FEA-1749)", () => {
    // The regression this phase exists to prevent. Ad-hoc local work carries a
    // repo and nothing else; it is honestly unparented, not attributable to
    // whichever project the repo's team happens to own.
    const session = makeSession({ repositoryFullName: "acme/web" });

    expect(resolveProjectId(session, makeResolution())).toBeNull();
  });

  it("returns null for repository-only attribution even alongside lineage that does not resolve", () => {
    const session = makeSession({
      repositoryFullName: "acme/web",
      sourceArtifactId: "019f66f7-0804-7737-834f-000000000000",
      sourceLoopId: "019f672d-f39d-72ee-9479-000000000000",
    });

    // Neither id is in the maps, and the repo must not rescue the attribution.
    expect(resolveProjectId(session, makeResolution())).toBeNull();
  });

  it("returns null when the session has no attribution at all", () => {
    expect(resolveProjectId(makeSession(null), makeResolution())).toBeNull();
  });

  it("ignores a non-uuid sourceArtifactId rather than treating it as a key", () => {
    const session = makeSession({ sourceArtifactId: "not-a-uuid" });

    expect(resolveProjectId(session, makeResolution())).toBeNull();
  });
});

describe("resolveProjectResolution", () => {
  it("never looks up repositories — the repo→project inference is gone (FEA-1749)", async () => {
    // This is the test that actually FAILS if the inference is reintroduced.
    // The `resolveProjectId` cases above pin the contract, but they cannot catch
    // a regression on their own: the fixture they build has no repository map,
    // so a restored fallback would read `undefined` and still return null. The
    // load-bearing guard is here (the query must not happen) and in the type —
    // `SessionProjectResolution` no longer carries a repository map at all.
    const repoFindMany = vi.fn();
    const tx = {
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
      loop: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubInstallationRepository: { findMany: repoFindMany },
    } as unknown as AgentSessionUpsertTx;

    const resolution = await resolveProjectResolution(tx, "org-1", [
      makeSession({ repositoryFullName: "acme/web" }),
    ]);

    expect(repoFindMany).not.toHaveBeenCalled();
    expect(resolution.artifactProjectById.size).toBe(0);
    expect(resolution.loopProjectById.size).toBe(0);
  });

  it("still resolves lineage maps from source artifacts and loops", async () => {
    const tx = {
      artifact: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: ARTIFACT_ID, projectId: PROJECT_FROM_ARTIFACT },
          ]),
      },
      loop: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: LOOP_ID,
            artifactId: null,
            artifact: { projectId: PROJECT_FROM_LOOP },
          },
        ]),
      },
      gitHubInstallationRepository: { findMany: vi.fn() },
    } as unknown as AgentSessionUpsertTx;

    const resolution = await resolveProjectResolution(tx, "org-1", [
      makeSession({ sourceArtifactId: ARTIFACT_ID, sourceLoopId: LOOP_ID }),
    ]);

    expect(resolution.artifactProjectById.get(ARTIFACT_ID)).toBe(
      PROJECT_FROM_ARTIFACT
    );
    expect(resolution.loopProjectById.get(LOOP_ID)).toBe(PROJECT_FROM_LOOP);
  });
});
