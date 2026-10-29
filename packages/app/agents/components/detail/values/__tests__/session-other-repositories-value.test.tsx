// PLN-2061 M5 / PLN-2169 M2: the pills naming the repositories the org does
// not track that the session touched — the value the Properties row draws and
// the Details tab (M3) will.

import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import type { SessionUntrackedRepositoryTarget } from "@repo/api/src/types/session-untracked-repository";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionOtherRepositoriesValue } from "../session-other-repositories-value";

const UPSTREAM_PR: SessionUntrackedRepositoryTarget = {
  kind: ArtifactRefTargetKind.PullRequest,
  repositoryFullName: "prisma/prisma-engines",
  prNumber: 5860,
  url: "https://github.com/prisma/prisma-engines/pull/5860",
};

const UNLINKABLE_BRANCH: SessionUntrackedRepositoryTarget = {
  kind: ArtifactRefTargetKind.Branch,
  repositoryFullName: "..",
  branchName: "fix/upstream",
};

describe("SessionOtherRepositoriesValue", () => {
  it("links the repository and PR number to the retained url", () => {
    render(<SessionOtherRepositoriesValue targets={[UPSTREAM_PR]} />);

    const link = screen.getByRole("link", {
      name: "prisma/prisma-engines #5860",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/prisma/prisma-engines/pull/5860"
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("renders an entry with no url as plain text, not a link", () => {
    render(<SessionOtherRepositoriesValue targets={[UNLINKABLE_BRANCH]} />);

    const pill = screen.getByText("fix/upstream").closest(".sd3-result-pr");
    expect(pill?.textContent).toBe(".. fix/upstream");
    // `closest("a")`, not a link-role query: an anchor with no href has no link
    // role, so a role query stays green on exactly the regression this guards.
    expect(pill?.closest("a")).toBeNull();
  });

  it("renders one pill per target, in the served order", () => {
    const { container } = render(
      <SessionOtherRepositoriesValue
        targets={[UPSTREAM_PR, UNLINKABLE_BRANCH]}
      />
    );

    const pills = [...container.querySelectorAll(".sd3-other-repo-pill")].map(
      (pill) => pill.textContent
    );
    expect(pills).toEqual(["prisma/prisma-engines #5860", ".. fix/upstream"]);
  });

  it("renders nothing for no targets", () => {
    const { container } = render(
      <SessionOtherRepositoriesValue targets={[]} />
    );

    expect(container).toBeEmptyDOMElement();
  });
});
