/**
 * FEA-3299 regression: the installation_repositories webhook must not fan out
 * unbounded pooled DB work over the repository list GitHub sends.
 *
 * This is the highest-exposure instance of the class: it is externally
 * triggered (no user auth gates it), `repositories_added` is whatever GitHub
 * decides to send — granting an app access to "all repositories" on a large org
 * yields one webhook carrying hundreds of entries — and each publish opens
 * several pooled connections plus an interactive transaction per eligible
 * target, holding them across many serialized round-trips. Unbounded, one grant
 * change could drain the pool of 20 and hang every other route (PRD-528).
 *
 * Concurrency is measured at `githubDirtyScopeService.publish` — one frame BELOW
 * the mapped `publishGitHubDirtyScopes` — so the real publisher (and its
 * best-effort try/catch) still runs, and an unbounded fan-out would register a
 * peak of N here rather than being hidden by the mock.
 */
import type {
  InstallationRepositoriesAddedEvent,
  InstallationRepositoriesRemovedEvent,
} from "@octokit/webhooks-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DB_FANOUT_MAX_CONCURRENCY } from "@/lib/db-fanout";

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  findInstallationByInstallationId: vi.fn(),
  addRepositories: vi.fn(),
  removeRepositories: vi.fn(),
}));

vi.mock("@/app/integrations/github/dirty-scope-service", () => ({
  githubDirtyScopeService: { publish: mocks.publish },
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: {
    findInstallationByInstallationId: mocks.findInstallationByInstallationId,
    addRepositories: mocks.addRepositories,
    removeRepositories: mocks.removeRepositories,
  },
}));

import {
  handleInstallationRepositoriesAdded,
  handleInstallationRepositoriesRemoved,
} from "../installation-repositories-handler";

const ORG_ID = "org-1";
const INSTALLATION_ROW_ID = "installation-row-1";

// Sized off the bound, not hardcoded: must always exceed
// DB_FANOUT_MAX_CONCURRENCY or the assertion has no power.
const REPO_COUNT = DB_FANOUT_MAX_CONCURRENCY * 2 + 2;

function trackPeak() {
  const state = { inFlight: 0, peak: 0 };
  const enter = async (): Promise<void> => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    state.inFlight -= 1;
  };
  return { enter, state };
}

function buildRepos(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `repo-row-${i}`,
    githubRepoId: String(1000 + i),
    fullName: `acme/repo-${i}`,
  }));
}

function buildRepoPayload(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: 1000 + i,
    name: `repo-${i}`,
    full_name: `acme/repo-${i}`,
    node_id: `node-${i}`,
    private: false,
  }));
}

// The handlers read only `installation` and the repository list; the full
// Octokit event type carries dozens of unrelated fields, so cast a narrow
// fixture rather than construct one.
function buildAddedEvent(count: number): InstallationRepositoriesAddedEvent {
  return {
    installation: { id: 42, account: { login: "acme" } },
    repositories_added: buildRepoPayload(count),
  } as unknown as InstallationRepositoriesAddedEvent;
}

function buildRemovedEvent(
  count: number
): InstallationRepositoriesRemovedEvent {
  return {
    installation: { id: 42, account: { login: "acme" } },
    repositories_removed: buildRepoPayload(count),
  } as unknown as InstallationRepositoriesRemovedEvent;
}

describe("installation_repositories webhook fan-out (FEA-3299)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("added", () => {
    beforeEach(() => {
      mocks.findInstallationByInstallationId.mockResolvedValue({
        id: INSTALLATION_ROW_ID,
        organizationId: ORG_ID,
      });
      mocks.addRepositories.mockResolvedValue(buildRepos(REPO_COUNT));
    });

    it("bounds concurrent dirty-scope publishes", async () => {
      const { enter, state } = trackPeak();
      mocks.publish.mockImplementation(() => enter());

      await handleInstallationRepositoriesAdded(buildAddedEvent(REPO_COUNT));

      // An unbounded Promise.all would peak at 12 here — and at hundreds for a
      // real "all repositories" grant on a large org.
      expect(state.peak).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
      expect(state.peak).toBeGreaterThan(1);
    });

    it("still publishes a dirty scope for every added repository", async () => {
      mocks.publish.mockResolvedValue(undefined);

      await handleInstallationRepositoriesAdded(buildAddedEvent(REPO_COUNT));

      // Bounding must not drop work.
      expect(mocks.publish).toHaveBeenCalledTimes(REPO_COUNT);
      expect(mocks.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          repositoryId: "repo-row-0",
          repositoryFullName: "acme/repo-0",
        })
      );
    });

    it("keeps one repository's publish failure from aborting the rest", async () => {
      // The bounded mapper is fail-fast, so this only holds because
      // publishGitHubDirtyScopes swallows per-repo errors internally. If that
      // ever changes, a single bad repo would abandon the remaining publishes
      // and silently skip their pull hints.
      mocks.publish.mockImplementation(
        ({ repositoryId }: { repositoryId: string }) =>
          repositoryId === "repo-row-3"
            ? Promise.reject(new Error("publish boom"))
            : Promise.resolve(undefined)
      );

      await expect(
        handleInstallationRepositoriesAdded(buildAddedEvent(REPO_COUNT))
      ).resolves.toBeUndefined();

      expect(mocks.publish).toHaveBeenCalledTimes(REPO_COUNT);
    });
  });

  describe("removed", () => {
    beforeEach(() => {
      mocks.findInstallationByInstallationId.mockResolvedValue({
        id: INSTALLATION_ROW_ID,
        organizationId: ORG_ID,
        repositories: buildRepos(REPO_COUNT),
      });
      mocks.removeRepositories.mockResolvedValue(undefined);
    });

    it("bounds concurrent dirty-scope publishes", async () => {
      const { enter, state } = trackPeak();
      mocks.publish.mockImplementation(() => enter());

      await handleInstallationRepositoriesRemoved(
        buildRemovedEvent(REPO_COUNT)
      );

      expect(state.peak).toBeLessThanOrEqual(DB_FANOUT_MAX_CONCURRENCY);
      expect(state.peak).toBeGreaterThan(1);
    });

    it("still publishes a dirty scope for every removed repository", async () => {
      mocks.publish.mockResolvedValue(undefined);

      await handleInstallationRepositoriesRemoved(
        buildRemovedEvent(REPO_COUNT)
      );

      expect(mocks.publish).toHaveBeenCalledTimes(REPO_COUNT);
    });
  });
});
