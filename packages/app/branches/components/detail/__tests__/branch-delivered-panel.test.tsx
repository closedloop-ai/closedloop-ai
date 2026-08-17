import {
  BranchLinkedArtifactCollectionProvenance,
  BranchLinkedArtifactCollectionState,
  type BranchPageDetail,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import { BranchDeliveredPanel } from "../branch-delivered-panel";

const WHAT_DELIVERED = "What was delivered";
const NO_ARTIFACTS_RE = /no linked artifacts/i;
const ARTIFACTS_UNAVAILABLE_RE = /linked artifacts are unavailable/i;
const NO_PR_DESC_RE = /no pull request opened yet/i;
const SHOW_FULL_RE = /show full description/i;
const SHOW_LESS_RE = /show less/i;
const CLOSEDLOOP_ARTIFACT_RE = /closedloop artifact/i;
const AUTOMATION_MARKER = "ISS-4783-AUTOMATION-METADATA";
const MARKDOWN_BODY = `# Summary

This PR includes **formatted delivery evidence**.

- [x] Render GitHub Markdown

## Testing

### Caveats

| Surface | State |
| --- | --- |
| Web | Ready |

Use \`pnpm test\` and read the [release note](https://github.com/octo/repo/pull/7).

![Architecture diagram](https://example.com/architecture.png)

[![Build status](https://example.com/badge.svg)](https://example.com/build)

<img alt="Pasted architecture" src="https://example.com/pasted.png">
<img alt="Unsafe pasted image" src="data:image/png;base64,unsafe">

\`\`\`html
<!-- documented comment syntax -->
\`\`\`

[Unsafe script](javascript:alert(1))
[Unsafe data](data:text/html,unsafe)
[Unsafe file](file:///tmp/unsafe)
[Relative link](/octo/repo)
[Protocol-relative link](//example.com/unsafe)
[Fragment link](#summary)

![Unsafe image](data:image/png;base64,unsafe)

<!-- ${AUTOMATION_MARKER} -->`;

describe("BranchDeliveredPanel", () => {
  it("renders the 'What was delivered' header and the linked-artifacts box (box 1)", () => {
    render(<BranchDeliveredPanel detail={makeBranchDetail()} />);
    expect(screen.getByText(WHAT_DELIVERED)).toBeInTheDocument();
    // Box 1 is for linked artifacts (documents/issues), NOT the PR.
    expect(screen.getByText(ARTIFACTS_UNAVAILABLE_RE)).toBeInTheDocument();
  });

  it("renders the exact complete-empty copy without a selected PR", () => {
    render(
      <BranchDeliveredPanel
        detail={makeBranchDetail({
          linkedArtifactsCollection: {
            state: BranchLinkedArtifactCollectionState.Complete,
            provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
          },
        })}
      />
    );

    expect(screen.getByText("No linked artifacts.")).toBeInTheDocument();
    expect(
      screen.queryByText(ARTIFACTS_UNAVAILABLE_RE)
    ).not.toBeInTheDocument();
  });

  it.each([
    BranchLinkedArtifactCollectionState.Incomplete,
    BranchLinkedArtifactCollectionState.Unavailable,
  ])("does not render complete-empty copy for %s evidence", (collectionState) => {
    render(
      <BranchDeliveredPanel
        detail={makeBranchDetail({
          linkedArtifactsCollection: {
            state: collectionState,
            provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
          },
        })}
      />
    );

    expect(screen.queryByText(NO_ARTIFACTS_RE)).not.toBeInTheDocument();
    expect(screen.getByText(ARTIFACTS_UNAVAILABLE_RE)).toBeInTheDocument();
  });

  it("does not add a technical completeness note to unavailable evidence", () => {
    render(
      <BranchDeliveredPanel
        detail={makeBranchDetail({
          linkedArtifactsCollection: {
            state: BranchLinkedArtifactCollectionState.Unavailable,
            provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
          },
        })}
      />
    );

    expect(
      screen.getByText("Linked artifacts are unavailable.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Linked artifact completeness could not be verified.")
    ).not.toBeInTheDocument();
  });

  it("does not render empty copy for a populated complete collection", () => {
    render(
      <BranchDeliveredPanel
        detail={makeBranchDetail({
          linkedArtifacts: [{ slug: "ISS-5561" }],
          linkedArtifactsCollection: {
            state: BranchLinkedArtifactCollectionState.Complete,
            provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
          },
        })}
      />
    );

    expect(screen.getByText("ISS-5561")).toBeInTheDocument();
    expect(screen.queryByText(NO_ARTIFACTS_RE)).not.toBeInTheDocument();
    expect(
      screen.queryByText(ARTIFACTS_UNAVAILABLE_RE)
    ).not.toBeInTheDocument();
  });

  it("lists linked Closedloop artifacts (slug) in box 1 when present", () => {
    const detail = makeBranchDetail({
      linkedArtifacts: [{ slug: "FEA-1952" }, { slug: "PLN-988" }],
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("FEA-1952")).toBeInTheDocument();
    expect(screen.getByText("PLN-988")).toBeInTheDocument();
    expect(screen.queryByText(NO_ARTIFACTS_RE)).not.toBeInTheDocument();
  });

  it("renders the whole row as a link to its canonical record, named by kind + key, when getArtifactHref resolves (FEA-4292)", () => {
    const detail = makeBranchDetail({
      linkedArtifacts: [{ slug: "FEA-3595" }, { slug: "PLN-988" }],
    });
    // Mirrors the web shell seam: slug → org-relative artifact route.
    const getArtifactHref = (slug: string) => `/acme/artifacts/${slug}`;
    render(
      <AppCoreStoryProviders>
        <BranchDeliveredPanel
          detail={detail}
          getArtifactHref={getArtifactHref}
        />
      </AppCoreStoryProviders>
    );

    // Accessible name leads with the artifact KIND (not a verb), matching the
    // Session Properties pill — "Issue FEA-3595", not "Open Closedloop artifact …".
    const feaLink = screen.getByRole("link", { name: "Issue FEA-3595" });
    expect(feaLink).toHaveAttribute("href", "/acme/artifacts/FEA-3595");
    // The full row is the target: it carries both the slug and its kind label.
    expect(feaLink).toHaveTextContent("FEA-3595");
    expect(feaLink).toHaveTextContent("Issue");

    const plnLink = screen.getByRole("link", { name: "Plan PLN-988" });
    expect(plnLink).toHaveAttribute("href", "/acme/artifacts/PLN-988");
    expect(plnLink).toHaveTextContent("Plan");
  });

  it("renders an absolute Desktop destination as an external browser link", () => {
    const href = "https://app.closedloop.test/acme/issues/FEA-3595";
    render(
      <BranchDeliveredPanel
        detail={makeBranchDetail({
          linkedArtifacts: [{ slug: "FEA-3595" }],
        })}
        getArtifactHref={() => href}
      />
    );

    const link = screen.getByRole("link", { name: "Issue FEA-3595" });
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("names each row by its derived kind (Issue/PRD/Plan) instead of a repeated generic label (FEA-4292)", () => {
    const detail = makeBranchDetail({
      linkedArtifacts: [
        { slug: "FEA-1" },
        { slug: "PRD-2" },
        { slug: "PLN-3" },
      ],
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("Issue")).toBeInTheDocument();
    expect(screen.getByText("PRD")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    // The old repeated "Closedloop artifact" title is gone.
    expect(screen.queryByText(CLOSEDLOOP_ARTIFACT_RE)).not.toBeInTheDocument();
  });

  it("falls back to a plain 'Artifact' kind for an untyped/unlabelled slug (FEA-4292)", () => {
    const detail = makeBranchDetail({
      linkedArtifacts: [{ slug: "WRK-12" }],
    });
    render(
      <BranchDeliveredPanel detail={detail} getArtifactHref={() => null} />
    );

    expect(screen.getByText("WRK-12")).toBeInTheDocument();
    expect(screen.getByText("Artifact")).toBeInTheDocument();
  });

  it("renders a linked artifact as inert text (no link) when no getArtifactHref is provided", () => {
    const detail = makeBranchDetail({
      linkedArtifacts: [{ slug: "FEA-3595" }],
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("FEA-3595")).toBeInTheDocument();
    // No shell href seam → no navigation affordance (the pre-FEA-4292 behavior).
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders a linked artifact as inert text when getArtifactHref returns null for its slug (FEA-4292)", () => {
    const detail = makeBranchDetail({
      linkedArtifacts: [{ slug: "WRK-12" }],
    });
    // A non-navigable/untyped slug resolves to null → plain label, no link.
    render(
      <BranchDeliveredPanel detail={detail} getArtifactHref={() => null} />
    );

    expect(screen.getByText("WRK-12")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders the PR identity (number, title, state, external link) in box 2", () => {
    const detail = makeBranchDetail({
      prNumber: 42,
      prTitle: "Add the thing",
      prUrl: "https://github.com/octo/repo/pull/42",
      prState: "OPEN",
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("Add the thing")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/octo/repo/pull/42"
    );
  });

  it("keeps a selected merged PR separate from the complete linked-artifact empty state", () => {
    const detail = selectedIdentityDetail();
    render(
      <BranchDeliveredPanel
        detail={{
          ...detail,
          linkedArtifacts: [],
          linkedArtifactsCollection: {
            state: BranchLinkedArtifactCollectionState.Complete,
            provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
          },
          selectedPullRequest: {
            ...detail.selectedPullRequest!,
            state: GitHubPRState.Merged,
          },
        }}
      />
    );

    expect(screen.getByText("No linked artifacts.")).toBeInTheDocument();
    expect(
      screen.queryByText(ARTIFACTS_UNAVAILABLE_RE)
    ).not.toBeInTheDocument();
    expect(screen.getByText("#22")).toBeInTheDocument();
    expect(screen.getByText("Selected pull request")).toBeInTheDocument();
    expect(screen.getByText("Merged")).toBeInTheDocument();
    expect(screen.getByText("Selected body")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/octo/repo/pull/22"
    );
  });

  it("keeps selected PR identity atomic when compatibility metadata names another PR", () => {
    render(<BranchDeliveredPanel detail={selectedIdentityDetail()} />);

    expect(screen.getByText("#22")).toBeInTheDocument();
    expect(screen.getByText("Selected pull request")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/octo/repo/pull/22"
    );
    expect(screen.queryByText("#11")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Compatibility pull request")
    ).not.toBeInTheDocument();
  });

  it("does not fill nullable selected identity fields from compatibility metadata", () => {
    const detail = selectedIdentityDetail();
    render(
      <BranchDeliveredPanel
        detail={{
          ...detail,
          selectedPullRequest: {
            ...detail.selectedPullRequest!,
            title: null,
            url: null,
          },
        }}
      />
    );

    expect(screen.getByText("#22")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(
      screen.queryByText("Compatibility pull request")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("falls back to compatibility body metadata only for a null selected body", () => {
    const detail = selectedIdentityDetail();
    render(
      <BranchDeliveredPanel
        detail={{
          ...detail,
          selectedPullRequest: {
            ...detail.selectedPullRequest!,
            body: null,
          },
        }}
      />
    );

    expect(screen.getByText("Compatibility body")).toBeInTheDocument();
  });

  it("treats whitespace as an explicit selected body without compatibility fallback", () => {
    const detail = selectedIdentityDetail();
    render(
      <BranchDeliveredPanel
        detail={{
          ...detail,
          selectedPullRequest: {
            ...detail.selectedPullRequest!,
            body: "   ",
          },
        }}
      />
    );

    expect(screen.queryByText("Compatibility body")).not.toBeInTheDocument();
    expect(
      screen.getByText("Pull request #22 has no description captured yet.")
    ).toBeInTheDocument();
  });

  it("preserves compatibility identity and body when no selected PR exists", () => {
    const detail = selectedIdentityDetail();
    render(
      <BranchDeliveredPanel detail={{ ...detail, selectedPullRequest: null }} />
    );

    expect(screen.getByText("#11")).toBeInTheDocument();
    expect(screen.getByText("Compatibility pull request")).toBeInTheDocument();
    expect(screen.getByText("Merged")).toBeInTheDocument();
    expect(screen.getByText("Compatibility body")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/octo/repo/pull/11"
    );
  });

  it("renders the read-only PR description body when present (no composer)", () => {
    const detail = makeBranchDetail({
      prNumber: 7,
      prBody: "This PR does the work.",
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("This PR does the work.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("renders the selected PR description as safe panel-scoped GitHub Markdown", () => {
    const detail = makeBranchDetail({
      prNumber: 7,
      prBody: "Compatibility body must not render.",
      linkedArtifacts: [{ slug: "ISS-4783" }],
      selectedPullRequest: {
        id: "octo/repo#7",
        repositoryFullName: "octo/repo",
        number: 7,
        title: "Render PR descriptions",
        url: "https://github.com/octo/repo/pull/7",
        state: "OPEN",
        isDraft: false,
        reviewDecision: null,
        openedAt: "2026-08-01T00:00:00.000Z",
        closedAt: null,
        mergedAt: null,
        body: MARKDOWN_BODY,
        headRefOid: "b".repeat(40),
        mergeCommitSha: null,
        changedFiles: 1,
        additions: 10,
        deletions: 2,
      },
    });
    const { container } = render(<BranchDeliveredPanel detail={detail} />);

    expect(
      screen.getByRole("heading", { level: 4, name: "Summary" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 5, name: "Testing" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 6, name: "Caveats" })
    ).toBeInTheDocument();
    expect(screen.getByText("formatted delivery evidence").tagName).toBe(
      "STRONG"
    );
    const taskCheckbox = screen.getByRole("checkbox", {
      name: "Completed task",
    });
    expect(taskCheckbox).toBeChecked();
    expect(taskCheckbox).toHaveAttribute("readonly");
    expect(taskCheckbox).not.toBeDisabled();
    fireEvent.click(taskCheckbox);
    expect(taskCheckbox).toBeChecked();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("pnpm test").tagName).toBe("CODE");
    expect(screen.queryByText(AUTOMATION_MARKER)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Compatibility body must not render.")
    ).not.toBeInTheDocument();

    const releaseLink = screen.getByRole("link", { name: "release note" });
    expect(releaseLink).toHaveAttribute("target", "_blank");
    expect(releaseLink).toHaveAttribute("rel", "noreferrer noopener");
    const imageLink = screen.getByRole("link", {
      name: "Architecture diagram",
    });
    expect(imageLink).toHaveAttribute(
      "href",
      "https://example.com/architecture.png"
    );
    expect(container.querySelector("img")).not.toBeInTheDocument();
    const badgeLink = screen.getByRole("link", { name: "Build status" });
    expect(badgeLink).toHaveAttribute("href", "https://example.com/build");
    expect(badgeLink.querySelector("a")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Pasted architecture" })
    ).toHaveAttribute("href", "https://example.com/pasted.png");
    expect(
      screen.getByText("Image omitted: Unsafe pasted image")
    ).toBeInTheDocument();
    expect(
      screen.getByText("<!-- documented comment syntax -->").closest("code")
    ).toBeInTheDocument();
    for (const name of [
      "Unsafe script",
      "Unsafe data",
      "Unsafe file",
      "Relative link",
      "Protocol-relative link",
      "Fragment link",
      "Unsafe image",
    ]) {
      expect(screen.getByText(name)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
    }

    const bodyElement = container.querySelector(".bq-ctx-prbody");
    expect(bodyElement?.textContent).not.toContain(AUTOMATION_MARKER);
    expect(bodyElement?.innerHTML).not.toContain(AUTOMATION_MARKER);
    expect(bodyElement?.innerHTML).not.toContain("<!--");

    const sectionChildren = Array.from(
      container.querySelector(".bq-ctx")?.children ?? []
    );
    expect(
      sectionChildren.indexOf(
        container.querySelector(".bq-ctx-issues")?.parentElement as Element
      )
    ).toBeLessThan(
      sectionChildren.indexOf(container.querySelector(".bq-ctx-pr")!)
    );
  });

  it("exposes the description toggle's collapsed/expanded state via aria-expanded", () => {
    const detail = makeBranchDetail({
      prNumber: 7,
      prBody: "This PR does the work.",
    });
    render(<BranchDeliveredPanel detail={detail} />);

    const toggle = screen.getByRole("button", { name: SHOW_FULL_RE });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".bq-ctx-prbody")).toHaveClass("clamped");
    expect(document.querySelector(".bq-ctx-prbody")).toHaveAttribute("inert");

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: SHOW_LESS_RE })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(document.querySelector(".bq-ctx-prbody")).not.toHaveClass("clamped");
    expect(document.querySelector(".bq-ctx-prbody")).not.toHaveAttribute(
      "inert"
    );

    fireEvent.click(screen.getByRole("button", { name: SHOW_LESS_RE }));
    expect(screen.getByRole("button", { name: SHOW_FULL_RE })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(document.querySelector(".bq-ctx-prbody")).toHaveClass("clamped");
    expect(document.querySelector(".bq-ctx-prbody")).toHaveAttribute("inert");
  });

  it("shows the no-PR empty state in box 2 while box 1 stays the artifacts box", () => {
    const detail = makeBranchDetail({
      prNumber: null,
      prTitle: null,
      prUrl: null,
      prState: null,
      prBody: null,
      linkedPrNumbers: [],
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText(ARTIFACTS_UNAVAILABLE_RE)).toBeInTheDocument();
    expect(screen.getByText(NO_PR_DESC_RE)).toBeInTheDocument();
    // No PR → no external link.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

function selectedIdentityDetail(): BranchPageDetail {
  return makeBranchDetail({
    prBody: "Compatibility body",
    prNumber: 11,
    prState: GitHubPRState.Merged,
    prTitle: "Compatibility pull request",
    prUrl: "https://github.com/octo/repo/pull/11",
    selectedPullRequest: {
      additions: 10,
      body: "Selected body",
      changedFiles: 1,
      closedAt: null,
      deletions: 2,
      headRefOid: "b".repeat(40),
      id: "octo/repo#22",
      isDraft: false,
      mergeCommitSha: null,
      mergedAt: null,
      number: 22,
      openedAt: "2026-08-01T00:00:00.000Z",
      repositoryFullName: "octo/repo",
      reviewDecision: null,
      state: GitHubPRState.Open,
      title: "Selected pull request",
      url: "https://github.com/octo/repo/pull/22",
    },
  });
}
