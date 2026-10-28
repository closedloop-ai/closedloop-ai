import {
  BranchLinkedArtifactCollectionProvenance,
  BranchLinkedArtifactCollectionState,
  type BranchPageDetail,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY } from "../../../../shared/lib/feature-flags";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import { BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL } from "../../../lib/branch-outcome-copy";
import {
  PULL_REQUEST_AUTHOR_UNKNOWN_LABEL as AUTHOR_UNKNOWN,
  PULL_REQUEST_BASE_UNKNOWN_LABEL as BASE_UNKNOWN,
} from "../../../lib/pull-request-provenance-display";
import { BranchDeliveredPanel } from "../branch-delivered-panel";

const WHAT_DELIVERED = "What was delivered";
const NO_ARTIFACTS_RE = /no linked artifacts/i;
const ARTIFACTS_UNAVAILABLE_RE = /linked artifacts are unavailable/i;
const NO_PR_DESC_RE = /no pull request opened yet/i;
const SHOW_FULL_RE = /show full description/i;
const SHOW_LESS_RE = /show less/i;
const CLOSEDLOOP_ARTIFACT_RE = /closedloop artifact/i;
const MEASURED_PROVENANCE = "Base main \u00b7 Opened by octocat";
const UNKNOWN_PROVENANCE = `${BASE_UNKNOWN} \u00b7 ${AUTHOR_UNKNOWN}`;
const OPENED_BY_OCTOCAT = "Opened by octocat";
const OPEN_STATE_LABEL = "Open";
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
  ])(
    "does not render complete-empty copy for %s evidence",
    (collectionState) => {
      render(
        <BranchDeliveredPanel
          detail={makeBranchDetail({
            linkedArtifactsCollection: {
              state: collectionState,
              provenance:
                BranchLinkedArtifactCollectionProvenance.CloudPersisted,
            },
          })}
        />
      );

      expect(screen.queryByText(NO_ARTIFACTS_RE)).not.toBeInTheDocument();
      expect(screen.getByText(ARTIFACTS_UNAVAILABLE_RE)).toBeInTheDocument();
    }
  );

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
    expect(screen.getByText(OPEN_STATE_LABEL)).toBeInTheDocument();
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
    expect(screen.getByText(OPEN_STATE_LABEL)).toBeInTheDocument();
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
    expect(screen.getByText(OPEN_STATE_LABEL)).toBeInTheDocument();
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
        baseRefName: "main",
        authorLogin: "octocat",
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

  // ISS-8422: the shape BOTH producers actually emit — a `selectedPullRequest`
  // carrying `state: OPEN` beside `lifecycleObserved: false`. `state` is
  // deliberately never widened to null, so this box read the raw OPEN and said
  // "Open" while the selector two inches above said "Unconfirmed" about the same
  // pull request. The compatibility-fallback case below CANNOT catch that: its
  // fixture has no `selectedPullRequest` at all, so it never takes this arm.
  it("states a SELECTED unobserved PR in box 2, never its placeholder OPEN", () => {
    const base = selectedIdentityDetail();
    const selected = base.selectedPullRequest;
    if (!selected) {
      throw new Error("the fixture must carry a selected pull request");
    }
    render(
      <BranchDeliveredPanel
        detail={{
          ...base,
          selectedPullRequest: {
            ...selected,
            lifecycleObserved: false,
            state: GitHubPRState.Open,
            title: null,
          },
        }}
      />
    );

    expect(screen.getByText("#22")).toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL)
    ).toBeInTheDocument();
    expect(screen.queryByText(OPEN_STATE_LABEL)).not.toBeInTheDocument();
  });

  // The COMPATIBILITY arm, where no `selectedPullRequest` is present and the box
  // falls back to `detail.prState`. Named for that arm deliberately: it was
  // called "states an unobserved PR in box 2" while pinning only this half, and
  // the sentence was read as coverage the production path never had.
  it("states an unobserved PR from the legacy fields instead of falling silent", () => {
    const detail = makeBranchDetail({
      prNumber: 42,
      prTitle: null,
      prUrl: "https://github.com/octo/repo/pull/42",
      prState: null,
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(
      screen.getByText(BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL)
    ).toBeInTheDocument();
    // Never the fabricated OPEN this whole change exists to stop restating.
    expect(screen.queryByText(OPEN_STATE_LABEL)).not.toBeInTheDocument();
  });

  it("still renders no state chip when there is no pull request at all", () => {
    const detail = makeBranchDetail({
      prNumber: null,
      prTitle: null,
      prUrl: null,
      prState: null,
    });
    render(<BranchDeliveredPanel detail={detail} />);

    expect(
      screen.queryByText(BRANCH_PULL_REQUEST_UNCONFIRMED_LABEL)
    ).not.toBeInTheDocument();
  });
});

/**
 * ISS-8241 Half B — the flag-gated base ref and author on the pull-request box.
 *
 * The literal below is a deliberate copy of the shared `@repo/api` leaf, pinned
 * here because the desktop Labs registry pins the same literal in
 * `apps/desktop/test/feature-flags-cross-surface.test.ts` and neither surface
 * imports the other. A rename that reached only one of them would leave the two
 * fields visible on one surface and hidden on the other, which is the leak the
 * closed-by-default policy requires both gates to prevent.
 */
describe("BranchDeliveredPanel selected-PR base ref and author (ISS-8241)", () => {
  it("pins the flag key the desktop Labs toggle registers", () => {
    expect(BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY).toBe(
      "branch-detail-pr-base-and-author"
    );
  });

  it("says nothing about the base ref or the author while the gate is closed", () => {
    render(
      <AppCoreStoryProviders>
        <BranchDeliveredPanel detail={selectedIdentityDetail()} />
      </AppCoreStoryProviders>
    );

    expect(screen.queryByText("main")).not.toBeInTheDocument();
    expect(screen.queryByText(OPENED_BY_OCTOCAT)).not.toBeInTheDocument();
    expect(screen.queryByText(BASE_UNKNOWN)).not.toBeInTheDocument();
    expect(screen.queryByText(AUTHOR_UNKNOWN)).not.toBeInTheDocument();
  });

  it("states the PR's own measured base ref and author when the gate is open", () => {
    render(
      <AppCoreStoryProviders
        enabledFlags={[BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY]}
      >
        <BranchDeliveredPanel detail={selectedIdentityDetail()} />
      </AppCoreStoryProviders>
    );

    // The ref is its own `font-mono` element, so `getByText` can never see the
    // whole statement — assert the paragraph's text, which also pins that the
    // two halves sit on ONE line in the stated order.
    expect(
      provenanceLine(screen.getByText(OPENED_BY_OCTOCAT))
    ).toHaveTextContent(MEASURED_PROVENANCE);
  });

  // The branch's own `baseBranch` sits on the same detail and is a plausible
  // stand-in, so an unmeasured base has to be seen NOT taking it: a PR that
  // never reported a target must not inherit whichever target the branch points
  // at now.
  it("names an unmeasured base ref and author instead of borrowing the branch's base", () => {
    const detail = selectedIdentityDetail();
    render(
      <AppCoreStoryProviders
        enabledFlags={[BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY]}
      >
        <BranchDeliveredPanel
          detail={{
            ...detail,
            baseBranch: "release/2026-09",
            selectedPullRequest: detail.selectedPullRequest
              ? {
                  ...detail.selectedPullRequest,
                  authorLogin: null,
                  baseRefName: null,
                }
              : null,
          }}
        />
      </AppCoreStoryProviders>
    );

    expect(provenanceLine(screen.getByText(BASE_UNKNOWN))).toHaveTextContent(
      UNKNOWN_PROVENANCE
    );
    expect(screen.queryByText("release/2026-09")).not.toBeInTheDocument();
  });

  // ISS-8155's `""` absent form reaches this box through the same wire, and a
  // nullish-only guard would render it as a blank that reads as "targets
  // nothing" rather than as the named absence.
  it("treats an empty measured value as absent, not as a blank", () => {
    const detail = selectedIdentityDetail();
    render(
      <AppCoreStoryProviders
        enabledFlags={[BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY]}
      >
        <BranchDeliveredPanel
          detail={{
            ...detail,
            selectedPullRequest: detail.selectedPullRequest
              ? {
                  ...detail.selectedPullRequest,
                  authorLogin: "",
                  baseRefName: "  ",
                }
              : null,
          }}
        />
      </AppCoreStoryProviders>
    );

    expect(provenanceLine(screen.getByText(BASE_UNKNOWN))).toHaveTextContent(
      UNKNOWN_PROVENANCE
    );
  });

  // A Desktop build newer than the cloud it reads receives these two keys
  // OMITTED, not null — the shape crosses a deploy boundary with no schema to
  // fill them in. Absent has to land in the same named absence as null and `""`,
  // or a supported version-skew response renders a blank or throws.
  it("names an omitted base ref and author instead of blanking the line", () => {
    render(
      <AppCoreStoryProviders
        enabledFlags={[BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY]}
      >
        <BranchDeliveredPanel
          detail={withoutProvenanceKeys(selectedIdentityDetail())}
        />
      </AppCoreStoryProviders>
    );

    expect(provenanceLine(screen.getByText(BASE_UNKNOWN))).toHaveTextContent(
      UNKNOWN_PROVENANCE
    );
  });

  // "the producer measured neither field" and "this response carries no PR
  // record" are different states. Only the first is something to say about a
  // pull request, so a compatibility response that has a PR NUMBER but no
  // selected-PR record must stay silent rather than report two unknowns.
  it("says nothing when the response carries a PR number but no PR record", () => {
    render(
      <AppCoreStoryProviders
        enabledFlags={[BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY]}
      >
        <BranchDeliveredPanel
          detail={{ ...selectedIdentityDetail(), selectedPullRequest: null }}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText("Pull request")).toBeInTheDocument();
    expect(screen.queryByText(BASE_UNKNOWN)).not.toBeInTheDocument();
    expect(screen.queryByText(AUTHOR_UNKNOWN)).not.toBeInTheDocument();
  });

  it("says nothing at all when the branch has no pull request to describe", () => {
    render(
      <AppCoreStoryProviders
        enabledFlags={[BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FEATURE_FLAG_KEY]}
      >
        <BranchDeliveredPanel detail={makeBranchDetail()} />
      </AppCoreStoryProviders>
    );

    expect(screen.queryByText(BASE_UNKNOWN)).not.toBeInTheDocument();
    expect(screen.queryByText(AUTHOR_UNKNOWN)).not.toBeInTheDocument();
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
      authorLogin: "octocat",
      baseRefName: "main",
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

/** The provenance paragraph that owns a rendered base-ref or author statement. */
function provenanceLine(statement: HTMLElement): HTMLElement {
  const line = statement.closest("p");
  if (!line) {
    throw new Error("the base ref and author statements must share one line");
  }
  return line;
}

/** The same detail with the ISS-8241 keys absent rather than null. */
function withoutProvenanceKeys(detail: BranchPageDetail): BranchPageDetail {
  const selected = detail.selectedPullRequest;
  if (!selected) {
    throw new Error("the fixture must carry a selected pull request");
  }
  const {
    authorLogin: _authorLogin,
    baseRefName: _baseRefName,
    ...withoutProvenance
  } = selected;
  return { ...detail, selectedPullRequest: withoutProvenance };
}
