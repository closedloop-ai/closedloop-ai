import {
  DeploymentEventSource,
  DeploymentEventState,
} from "@repo/api/src/types/deployment-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDeploymentStatusEvent } from "../deployment-status-parser";

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const INGEST_NOW = new Date("2026-08-03T12:00:00.000Z");

function buildPayload(overrides: Record<string, unknown> = {}) {
  return {
    deployment: {
      id: 4242,
      environment: "Preview",
      ref: "feature-branch",
      sha: "abc123",
      created_at: "2026-08-03T11:58:00.000Z",
      transient_environment: true,
      production_environment: false,
    },
    deployment_status: {
      id: 99_001,
      state: "success",
      environment_url: "https://preview.example.com",
      url: "https://api.github.com/status",
      deployment_url: "https://api.github.com/deployment",
      created_at: "2026-08-03T11:59:00.000Z",
    },
    repository: {
      id: 123,
      full_name: "org/repo",
    },
    ...overrides,
  };
}

describe("parseDeploymentStatusEvent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(INGEST_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes a success payload onto the history contract", () => {
    const parsed = parseDeploymentStatusEvent(buildPayload());

    expect(parsed).toEqual({
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
      repositoryExternalId: "123",
    });
  });

  it("parses a failure transition that carries no environment_url", () => {
    const parsed = parseDeploymentStatusEvent(
      buildPayload({
        deployment_status: {
          id: 99_002,
          state: "failure",
          url: "https://api.github.com/status",
          created_at: "2026-08-03T11:59:30.000Z",
        },
      })
    );

    expect(parsed?.state).toBe(DeploymentEventState.Failure);
    expect(parsed?.providerState).toBe("failure");
    expect(parsed?.environmentUrl).toBeNull();
    expect(parsed?.externalEventId).toBe("99002");
  });

  it.each([
    ["error", DeploymentEventState.Error],
    ["in_progress", DeploymentEventState.InProgress],
    ["queued", DeploymentEventState.Queued],
    ["pending", DeploymentEventState.Pending],
    ["inactive", DeploymentEventState.Inactive],
    ["SUCCESS", DeploymentEventState.Success],
  ])("maps provider state %s onto %s", (providerState, expected) => {
    const parsed = parseDeploymentStatusEvent(
      buildPayload({
        deployment_status: {
          id: 7,
          state: providerState,
          created_at: "2026-08-03T11:59:00.000Z",
        },
      })
    );

    expect(parsed?.state).toBe(expected);
  });

  it("degrades an unknown provider state to UNKNOWN and still parses", () => {
    const parsed = parseDeploymentStatusEvent(
      buildPayload({
        deployment_status: {
          id: 99_003,
          state: "quantum_rollout",
          created_at: "2026-08-03T11:59:00.000Z",
        },
      })
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.state).toBe(DeploymentEventState.Unknown);
    // The raw provider vocabulary is preserved so a state we cannot classify
    // today can be reclassified later without re-ingesting.
    expect(parsed?.providerState).toBe("quantum_rollout");
  });

  it("degrades a prototype-polluting state key to UNKNOWN", () => {
    const parsed = parseDeploymentStatusEvent(
      buildPayload({
        deployment_status: {
          id: 8,
          state: "constructor",
          created_at: "2026-08-03T11:59:00.000Z",
        },
      })
    );

    expect(parsed?.state).toBe(DeploymentEventState.Unknown);
  });

  it("keeps unknown additive payload fields from rejecting the event", () => {
    const parsed = parseDeploymentStatusEvent(
      buildPayload({
        deployment_status: {
          id: 99_004,
          state: "success",
          created_at: "2026-08-03T11:59:00.000Z",
          future_field: { nested: true },
        },
        unexpected_top_level: "ignored",
      })
    );

    expect(parsed?.state).toBe(DeploymentEventState.Success);
    expect(parsed?.externalEventId).toBe("99004");
  });

  it("accepts string provider ids as well as numeric ones", () => {
    const parsed = parseDeploymentStatusEvent(
      buildPayload({
        deployment: { id: "dep-1", ref: "main", sha: "def456" },
        deployment_status: {
          id: "st-1",
          state: "success",
          created_at: "2026-08-03T11:59:00.000Z",
        },
      })
    );

    expect(parsed?.externalDeploymentId).toBe("dep-1");
    expect(parsed?.externalEventId).toBe("st-1");
  });

  it("returns null when the payload carries no dedupe identity", () => {
    // The pre-ISS-4975 shape: no provider ids at all. Without both ids a
    // redelivery cannot be recognized, so appending would double-count.
    const parsed = parseDeploymentStatusEvent({
      deployment: { ref: "feature-branch", sha: "abc123" },
      deployment_status: { state: "success" },
      repository: { id: 123 },
    });

    expect(parsed).toBeNull();
  });

  it("returns null when only one half of the dedupe identity is present", () => {
    expect(
      parseDeploymentStatusEvent(
        buildPayload({ deployment_status: { state: "success" } })
      )
    ).toBeNull();
    expect(
      parseDeploymentStatusEvent(
        buildPayload({ deployment: { ref: "main", sha: "abc" } })
      )
    ).toBeNull();
  });

  it.each([
    ["unparseable", "not-a-date"],
    ["absent", undefined],
    ["empty", ""],
  ])("returns null when the provider occurrence time is %s, rather than substituting the ingest clock", (_label, createdAt) => {
    // Every DORA metric is a window or interval over occurredAt. Stamping the
    // ingest clock would put a delayed redelivery in the wrong window and
    // permanently skew MTTR ordering on a row that is immutable, so the honest
    // outcome is to skip history for this payload.
    const parsed = parseDeploymentStatusEvent(
      buildPayload({
        deployment: { id: 1, created_at: "2026-08-03T11:58:00.000Z" },
        deployment_status: {
          id: 2,
          state: "success",
          created_at: createdAt,
        },
      })
    );

    expect(parsed).toBeNull();
  });

  it("never stamps the ingest clock onto occurredAt for a valid payload", () => {
    const parsed = parseDeploymentStatusEvent(buildPayload());

    expect(parsed?.occurredAt).toEqual(new Date("2026-08-03T11:59:00.000Z"));
    expect(parsed?.occurredAt).not.toEqual(INGEST_NOW);
  });

  it("returns null for a payload that is not a deployment_status event", () => {
    expect(parseDeploymentStatusEvent({ action: "opened" })).toBeNull();
    expect(parseDeploymentStatusEvent(null)).toBeNull();
  });
});
