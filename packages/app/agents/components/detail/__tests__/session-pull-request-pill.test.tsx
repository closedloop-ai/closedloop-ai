// ISS-4793: focused tests for the PR pill extracted out of the grandfathered
// agent-session-detail-view.tsx. Covers the href resolution, the link-vs-inert
// branch, and the tooltip copy rules (status title-casing, subject truncation,
// absent-subject omission) that the pill's description depends on.

import {
  type SessionPR,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import {
  buildPullRequestTitle,
  buildUnresolvedPullRequestTitle,
  getPullRequestHref,
  PullRequestPill,
} from "../session-pull-request-pill";

const REPO = "closedloop-ai/symphony-alpha";
const PR_NUMBER_RE = /4170/;
const NO_REPOSITORY_REASON_RE = /No repository is linked to this session/;

function pr(overrides: Partial<SessionPR> = {}): SessionPR {
  return {
    num: 4170,
    status: "merged",
    title: "Enable the merge queue",
    ...overrides,
  };
}

describe("getPullRequestHref (ISS-4793)", () => {
  it("builds the GitHub URL from the repo and a positive PR number", () => {
    expect(getPullRequestHref(pr(), REPO)).toBe(
      "https://github.com/closedloop-ai/symphony-alpha/pull/4170"
    );
  });

  // An unresolved repository is the honest no-destination case: the pill must
  // stay a label rather than link somewhere invented.
  it("returns null when the repository is unresolved", () => {
    expect(getPullRequestHref(pr(), null)).toBeNull();
  });

  it.each([
    0,
    -3,
    "abc",
    "",
  ])("returns null for the non-PR-number %p", (num) => {
    expect(getPullRequestHref(pr({ num }), REPO)).toBeNull();
  });
});

describe("buildPullRequestTitle (ISS-4793)", () => {
  // The wire status is lowercase and only *looks* capitalized in the pill
  // because CSS transforms it, so the description has to title-case it or the
  // tooltip contradicts the pill a pixel away.
  it("title-cases the wire status so it matches the rendered pill", () => {
    expect(buildPullRequestTitle(pr())).toBe(
      "Pull request #4170 (Merged): Enable the merge queue. Opens on GitHub."
    );
  });

  it("truncates an unbounded subject instead of letting it become the tooltip", () => {
    const title = buildPullRequestTitle(pr({ title: "x".repeat(200) }));

    expect(title).toContain("…");
    expect(title.length).toBeLessThan(140);
    expect(title.endsWith("Opens on GitHub.")).toBe(true);
  });

  // No dangling separators when a field is absent — the copy has to read as a
  // sentence in every combination, not just the happy one.
  it("omits the subject and the status when they are absent", () => {
    expect(buildPullRequestTitle(pr({ title: "", status: "" }))).toBe(
      "Pull request #4170. Opens on GitHub."
    );
  });

  // The shape the API projection actually produces for "no subject":
  // `sessionPrWithLifecycle` fills an absent title with the literal `PR #<num>`
  // and `sessionPrSchema` requires min-length 1, so an empty string never
  // arrives — this placeholder does. Echoing it back would present the
  // projection's stand-in for missing data as the data.
  it("drops the `PR #<num>` placeholder instead of repeating it as the subject", () => {
    expect(buildPullRequestTitle(pr({ title: "PR #4170" }))).toBe(
      "Pull request #4170 (Merged). Opens on GitHub."
    );
  });

  // A title that merely CONTAINS the number is a real subject, not the sentinel.
  it("keeps a real subject that mentions the PR number", () => {
    expect(buildPullRequestTitle(pr({ title: "Revert PR #4170" }))).toBe(
      "Pull request #4170 (Merged): Revert PR #4170. Opens on GitHub."
    );
  });

  // `.sd3-result-status` is `text-transform: capitalize`, which capitalizes
  // EVERY word. A capitalize-first would render "Changes Requested" in the pill
  // and "Changes requested" in the tooltip a pixel below it.
  it("title-cases every word of a multi-word status", () => {
    expect(buildPullRequestTitle(pr({ status: "changes requested" }))).toBe(
      "Pull request #4170 (Changes Requested): Enable the merge queue. Opens on GitHub."
    );
  });

  // `unknown` is the projection's sentinel for "lifecycle not verified", not a
  // GitHub state, so it must not be dressed up as one inside the sentence.
  it("renders the unknown sentinel as not-verified rather than a state", () => {
    const title = buildPullRequestTitle(
      pr({ status: SessionPrLifecycleStatus.Unknown })
    );

    expect(title).toContain("(status not verified)");
    expect(title).not.toContain("(Unknown)");
  });
});

describe("PullRequestPill (ISS-4793)", () => {
  it("renders a resolved PR as an external link that opens a new tab", () => {
    render(
      <AppCoreStoryProviders>
        <PullRequestPill pr={pr()} repositoryFullName={REPO} />
      </AppCoreStoryProviders>
    );

    const link = screen.getByRole("link", { name: PR_NUMBER_RE });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/closedloop-ai/symphony-alpha/pull/4170"
    );
    expect(link).toHaveAttribute("target", "_blank");
    // rel guards the opened tab against reverse-tabnabbing.
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("keeps an unresolvable PR a non-link label", () => {
    const { container } = render(
      <AppCoreStoryProviders>
        <PullRequestPill pr={pr()} repositoryFullName={null} />
      </AppCoreStoryProviders>
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("span.sd3-result-pr")).not.toBeNull();
  });

  // The unresolvable pill is shaped exactly like the clickable one beside it, so
  // it is the case that most needs a sentence — before this it rendered bare.
  it("explains why an unresolvable PR has no destination", async () => {
    const user = userEvent.setup();
    render(
      <AppCoreStoryProviders>
        <PullRequestPill pr={pr()} repositoryFullName={null} />
      </AppCoreStoryProviders>
    );

    await user.hover(screen.getByText("4170"));
    expect(
      await screen.findAllByText(NO_REPOSITORY_REASON_RE)
    ).not.toHaveLength(0);
  });
});

describe("buildUnresolvedPullRequestTitle (ISS-4793)", () => {
  // The two causes mean different things to the reader, so the copy names the
  // one that actually applies rather than a single generic "unavailable".
  it("names an unlinked repository as the reason", () => {
    expect(buildUnresolvedPullRequestTitle(pr(), null)).toBe(
      "Pull request #4170 (Merged): Enable the merge queue. No repository is linked to this session, so it cannot be opened on GitHub."
    );
  });

  it("names an unusable PR number as the reason when the repo did resolve", () => {
    expect(buildUnresolvedPullRequestTitle(pr({ num: 0 }), REPO)).toBe(
      "Pull request #0 (Merged): Enable the merge queue. This reference has no usable pull request number, so it cannot be opened."
    );
  });
});
