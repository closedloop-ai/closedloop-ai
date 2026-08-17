import {
  RepositoryDefaultAvailability,
  RepositoryDefaultReason,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { describe, expect, it, vi } from "vitest";
import { createPullRequest } from "@/__tests__/fixtures/github-webhook-fixtures";
import { buildWebhookHeadRepositoryObservation } from "./pull-request-projection";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("@repo/observability/log", () => ({
  log: { error: logError },
}));

const context = {
  deliveryId: "delivery-5826",
  observedAt: new Date("2026-08-10T20:00:00.000Z"),
};

describe("buildWebhookHeadRepositoryObservation", () => {
  it("maps the fork head identity and custom default independently", () => {
    const pullRequest = createPullRequest();
    pullRequest.head.repo = {
      id: 5826,
      full_name: "fork-owner/test-repo",
      default_branch: "trunk",
    };

    const observation = buildWebhookHeadRepositoryObservation(
      pullRequest,
      context
    );

    expect(observation?.authority).toMatchObject({
      repository: {
        providerRepositoryId: "5826",
        fullName: "fork-owner/test-repo",
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Available,
        defaultBranch: "trunk",
      },
      provenance: {
        source: RepositoryDefaultSource.PullRequestWebhook,
        observationKey: context.deliveryId,
      },
    });
  });

  it("represents an inaccessible head without substituting the base", () => {
    const pullRequest = createPullRequest();
    pullRequest.head.repo = null;

    const observation = buildWebhookHeadRepositoryObservation(
      pullRequest,
      context
    );

    expect(observation).toEqual({
      unavailable: {
        reason: RepositoryDefaultReason.NotReported,
        provenance: expect.objectContaining({
          source: RepositoryDefaultSource.PullRequestWebhook,
          observationKey: context.deliveryId,
        }),
      },
    });
    expect(observation).not.toHaveProperty("authority.repository.fullName");
  });

  it("preserves omission when delivery provenance is absent", () => {
    const pullRequest = createPullRequest();
    pullRequest.head.repo = {
      id: 5826,
      full_name: "fork-owner/test-repo",
      default_branch: "trunk",
    };

    expect(
      buildWebhookHeadRepositoryObservation(pullRequest, undefined)
    ).toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "github_repository_default_authority_malformed",
      expect.objectContaining({
        outcome: "missing_delivery_id",
        providerPullRequestId: String(pullRequest.id),
      })
    );
  });
});
