import type { ArtifactRepositorySnapshot } from "@repo/api/src/types/document";
import { RepositoryRole, SnapshotSource } from "@repo/api/src/types/document";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactRepositoriesSummary } from "../artifact-repositories-summary";

function makeSnapshot(
  overrides?: Partial<ArtifactRepositorySnapshot>
): ArtifactRepositorySnapshot {
  return {
    repositories: [
      {
        fullName: "acme/api",
        role: RepositoryRole.Primary,
        position: 0,
      },
    ],
    source: SnapshotSource.ProjectDefaults,
    ...overrides,
  };
}

describe("ArtifactRepositoriesSummary", () => {
  describe("horizontal layout (metadata bar)", () => {
    it("renders the primary repo name as a pill", () => {
      render(<ArtifactRepositoriesSummary snapshot={makeSnapshot()} />);
      expect(screen.getByText("acme/api")).toBeInTheDocument();
    });

    it("renders additional repos alongside the primary", () => {
      const snapshot = makeSnapshot({
        repositories: [
          {
            fullName: "acme/api",
            role: RepositoryRole.Primary,
            position: 0,
          },
          {
            fullName: "acme/web",
            role: RepositoryRole.Additional,
            position: 1,
          },
          {
            fullName: "acme/shared",
            role: RepositoryRole.Additional,
            position: 2,
          },
        ],
      });
      render(<ArtifactRepositoriesSummary snapshot={snapshot} />);

      expect(screen.getByText("acme/api")).toBeInTheDocument();
      expect(screen.getByText("acme/web")).toBeInTheDocument();
      expect(screen.getByText("acme/shared")).toBeInTheDocument();
    });

    it("renders the branch as @branch suffix when present", () => {
      const snapshot = makeSnapshot({
        repositories: [
          {
            fullName: "acme/api",
            role: RepositoryRole.Primary,
            position: 0,
            branch: "feat/x",
          },
        ],
      });
      render(<ArtifactRepositoriesSummary snapshot={snapshot} />);
      expect(screen.getByText("@feat/x")).toBeInTheDocument();
    });

    it("marks the primary repo with a tooltip-style title attribute", () => {
      const { container } = render(
        <ArtifactRepositoriesSummary snapshot={makeSnapshot()} />
      );
      const primaryPill = container.querySelector(
        'span[title="acme/api (primary)"]'
      );
      expect(primaryPill).toBeInTheDocument();
    });

    it("places the primary repo before additional repos regardless of input order", () => {
      const snapshot = makeSnapshot({
        repositories: [
          {
            fullName: "acme/web",
            role: RepositoryRole.Additional,
            position: 5,
          },
          {
            fullName: "acme/api",
            role: RepositoryRole.Primary,
            position: 9,
          },
        ],
      });
      const { container } = render(
        <ArtifactRepositoriesSummary snapshot={snapshot} />
      );
      const pills = container.querySelectorAll("span[title]");
      expect(pills[0]).toHaveTextContent("acme/api");
      expect(pills[1]).toHaveTextContent("acme/web");
    });

    it("renders 'No repositories' when the snapshot has no entries", () => {
      const snapshot = makeSnapshot({
        repositories: [],
        source: SnapshotSource.None,
      });
      render(<ArtifactRepositoriesSummary snapshot={snapshot} />);
      expect(screen.getByText("No repositories")).toBeInTheDocument();
    });
  });

  describe("vertical layout (sidebar)", () => {
    it("renders the section title when provided", () => {
      render(
        <ArtifactRepositoriesSummary
          layout="vertical"
          snapshot={makeSnapshot()}
          title="Repositories"
        />
      );
      expect(
        screen.getByRole("heading", { name: "Repositories" })
      ).toBeInTheDocument();
    });

    it("labels the primary repo with the 'Primary' marker", () => {
      render(
        <ArtifactRepositoriesSummary
          layout="vertical"
          snapshot={makeSnapshot()}
        />
      );
      expect(screen.getByText("Primary")).toBeInTheDocument();
    });

    it("does not render a 'Primary' marker for additional-only entries", () => {
      const snapshot = makeSnapshot({
        repositories: [
          {
            fullName: "acme/api",
            role: RepositoryRole.Primary,
            position: 0,
          },
          {
            fullName: "acme/web",
            role: RepositoryRole.Additional,
            position: 1,
          },
        ],
      });
      render(
        <ArtifactRepositoriesSummary layout="vertical" snapshot={snapshot} />
      );
      const primaryLabels = screen.getAllByText("Primary");
      expect(primaryLabels).toHaveLength(1);
    });

    it("renders the branch as secondary text when present", () => {
      const snapshot = makeSnapshot({
        repositories: [
          {
            fullName: "acme/api",
            role: RepositoryRole.Primary,
            position: 0,
            branch: "main",
          },
        ],
      });
      render(
        <ArtifactRepositoriesSummary layout="vertical" snapshot={snapshot} />
      );
      expect(screen.getByText("main")).toBeInTheDocument();
    });

    it("falls back to ref when no branch is set", () => {
      const snapshot = makeSnapshot({
        repositories: [
          {
            fullName: "acme/api",
            role: RepositoryRole.Primary,
            position: 0,
            ref: "abc123",
          },
        ],
      });
      render(
        <ArtifactRepositoriesSummary layout="vertical" snapshot={snapshot} />
      );
      expect(screen.getByText("abc123")).toBeInTheDocument();
    });

    it("renders an empty-state message when no repositories exist", () => {
      const snapshot = makeSnapshot({
        repositories: [],
        source: SnapshotSource.None,
      });
      render(
        <ArtifactRepositoriesSummary layout="vertical" snapshot={snapshot} />
      );
      expect(screen.getByText("No repositories")).toBeInTheDocument();
    });
  });
});
