import {
  DeploymentEventSource,
  DeploymentEventState,
} from "@repo/api/src/types/deployment-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => {
  const mockWithDb: unknown = vi.fn();
  return { withDb: mockWithDb };
});

import { withDb } from "@repo/database";
import { deploymentEventService } from "@/app/deployments/deployment-event-service";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;

type CreateManyArgs = {
  data: Record<string, unknown>[];
  skipDuplicates?: boolean;
};

function baseInput() {
  return {
    organizationId: "org-1",
    projectId: "project-1",
    repositoryId: "repo-1",
    branchArtifactId: "branch-artifact-1",
    source: DeploymentEventSource.GitHub,
    externalDeploymentId: "4242",
    externalEventId: "99001",
    state: DeploymentEventState.Success,
    providerState: "success",
    environment: "Preview",
    ref: "feature-branch",
    sha: "abc123",
    environmentUrl: "https://preview.example.com",
    githubStatusUrl: "https://api.github.com/status",
    githubDeploymentUrl: "https://api.github.com/deployment",
    production: false,
    transient: true,
    occurredAt: new Date("2026-08-03T11:59:00.000Z"),
    deploymentCreatedAt: new Date("2026-08-03T11:58:00.000Z"),
  };
}

describe("deploymentEventService.recordEvent", () => {
  let createMany: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    createMany = vi.fn().mockResolvedValue({ count: 1 });
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ deploymentEvent: { createMany } })
    );
  });

  it("appends one immutable row with the full history shape", async () => {
    const result = await deploymentEventService.recordEvent(baseInput());

    expect(result.ok).toBe(true);
    const args = createMany.mock.calls[0][0] as CreateManyArgs;
    expect(args.data).toEqual([
      {
        organizationId: "org-1",
        projectId: "project-1",
        repositoryId: "repo-1",
        branchArtifactId: "branch-artifact-1",
        source: DeploymentEventSource.GitHub,
        externalDeploymentId: "4242",
        externalEventId: "99001",
        state: DeploymentEventState.Success,
        providerState: "success",
        environment: "Preview",
        ref: "feature-branch",
        sha: "abc123",
        environmentUrl: "https://preview.example.com",
        githubStatusUrl: "https://api.github.com/status",
        githubDeploymentUrl: "https://api.github.com/deployment",
        production: false,
        transient: true,
        occurredAt: new Date("2026-08-03T11:59:00.000Z"),
        deploymentCreatedAt: new Date("2026-08-03T11:58:00.000Z"),
      },
    ]);
  });

  it("writes through ON CONFLICT DO NOTHING rather than a read-then-write", async () => {
    await deploymentEventService.recordEvent(baseInput());

    const args = createMany.mock.calls[0][0] as CreateManyArgs;
    // skipDuplicates compiles to INSERT ... ON CONFLICT DO NOTHING against the
    // (organization_id, source, external_event_id) unique index, so concurrent
    // redeliveries resolve in the database instead of racing on a prior read.
    expect(args.skipDuplicates).toBe(true);
  });

  it("reports a duplicate delivery as not recorded instead of overwriting", async () => {
    createMany.mockResolvedValue({ count: 0 });

    const result = await deploymentEventService.recordEvent(baseInput());

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ recorded: false });
    // No update-in-place path exists: an already-recorded fact is never rewritten.
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("appends a second row for a re-deploy instead of replacing the first", async () => {
    const first = baseInput();
    const second = {
      ...baseInput(),
      externalEventId: "99002",
      externalDeploymentId: "4243",
      occurredAt: new Date("2026-08-03T13:00:00.000Z"),
    };

    await deploymentEventService.recordEvent(first);
    await deploymentEventService.recordEvent(second);

    expect(createMany).toHaveBeenCalledTimes(2);
    const firstArgs = createMany.mock.calls[0][0] as CreateManyArgs;
    const secondArgs = createMany.mock.calls[1][0] as CreateManyArgs;
    expect(firstArgs.data[0].externalEventId).toBe("99001");
    expect(secondArgs.data[0].externalEventId).toBe("99002");
    // Deployment frequency counts distinct deployments; both survive.
    expect(secondArgs.data[0].externalDeploymentId).toBe("4243");
  });

  it("records a failure state with no environment url", async () => {
    await deploymentEventService.recordEvent({
      ...baseInput(),
      state: DeploymentEventState.Failure,
      providerState: "failure",
      environmentUrl: null,
    });

    const args = createMany.mock.calls[0][0] as CreateManyArgs;
    expect(args.data[0].state).toBe(DeploymentEventState.Failure);
    expect(args.data[0].environmentUrl).toBeNull();
  });

  it("normalizes omitted optional fields to null rather than undefined", async () => {
    await deploymentEventService.recordEvent({
      organizationId: "org-1",
      source: DeploymentEventSource.GitHub,
      externalDeploymentId: "4242",
      externalEventId: "99001",
      state: DeploymentEventState.Unknown,
      providerState: "quantum_rollout",
      occurredAt: new Date("2026-08-03T11:59:00.000Z"),
    });

    const args = createMany.mock.calls[0][0] as CreateManyArgs;
    expect(args.data[0]).toMatchObject({
      projectId: null,
      repositoryId: null,
      branchArtifactId: null,
      environment: null,
      ref: null,
      sha: null,
      environmentUrl: null,
      production: null,
      transient: null,
      deploymentCreatedAt: null,
    });
  });
});
