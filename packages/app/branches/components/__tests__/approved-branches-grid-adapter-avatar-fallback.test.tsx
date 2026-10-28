import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BranchRow } from "../../lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "../../lib/branch-sample-data";
import { renderApprovedBranchCell } from "../approved-branches-grid-adapter";

/**
 * ISS-8972 — the Branches grid's own avatar, not the design system's.
 *
 * `renderApprovedBranchCell` is the renderer BOTH Branches hosts compose:
 * `apps/app`'s page and `apps/desktop`'s `BranchesView` reach the same
 * `PersonAvatar` through this one module, so the regression lives here rather
 * than being pasted into each shell's suite (whitlockk, PR #7393). The
 * shell-specific halves — providers, gates, routes — are the both-host
 * contract's job; what can break here is host-independent by construction.
 *
 * The bug: Radix's `Avatar.Root` caches `imageLoadingStatus` in context and
 * `AvatarImage` reports a change only while MOUNTED, so unmounting it once a
 * real picture had loaded left the Root reporting "loaded" forever and
 * `AvatarFallback` — which renders only while status !== "loaded" — never came
 * back. The collaborator's initials vanished instead of returning.
 */

const REPOSITORY_LABELS: ReadonlyMap<string, string> = new Map();
const OWNER_AVATAR_URL = "data:image/svg+xml,%3Csvg/%3E";

/**
 * jsdom's real `Image` never reports `complete`/`naturalWidth` — it decodes
 * nothing — which is exactly why this bug survived every existing suite:
 * nothing ever reached "loaded" to regress FROM. This stub decodes instantly,
 * as a small inline data URI does in a real browser.
 */
class InstantlyDecodedImage {
  complete = true;
  naturalWidth = 1;
  src = "";
  addEventListener(): void {
    return;
  }
  removeEventListener(): void {
    return;
  }
}

const previousImage = globalThis.Image;

function stubInstantlyDecodedImage(): void {
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: InstantlyDecodedImage,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: previousImage,
    writable: true,
  });
});

function collaboratorRow(avatarUrl: string | undefined): BranchRow {
  const base = BRANCH_SAMPLE_ROWS[0];
  if (!base) {
    throw new Error("BRANCH_SAMPLE_ROWS is empty");
  }
  return {
    ...base,
    collaborators: [{ avatarUrl, key: "avery", name: "Avery Carter" }],
  };
}

function CollaboratorsCell({ avatarUrl }: { avatarUrl?: string }) {
  return renderApprovedBranchCell(
    "collaborators",
    collaboratorRow(avatarUrl),
    REPOSITORY_LABELS,
    undefined,
    true
  );
}

describe("approved branches grid collaborator avatar", () => {
  it("falls back to initials when a loaded collaborator avatar disappears on rerender", () => {
    stubInstantlyDecodedImage();

    const { rerender } = render(
      <CollaboratorsCell avatarUrl="data:image/svg+xml,%3Csvg/%3E" />
    );

    // One initial on every avatar (Nerys, 2026-10-22).
    // The picture "loaded": Radix hides the fallback initials.
    expect(screen.queryByText("A")).not.toBeInTheDocument();

    rerender(<CollaboratorsCell />);

    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("shows initials for a collaborator who never had a picture", () => {
    render(<CollaboratorsCell />);

    expect(screen.getByText("A")).toBeInTheDocument();
  });
});

describe("approved branches grid owner avatar", () => {
  it("renders the available photo instead of Owner initials", () => {
    stubInstantlyDecodedImage();
    const base = BRANCH_SAMPLE_ROWS[0];
    if (!base) {
      throw new Error("BRANCH_SAMPLE_ROWS is empty");
    }
    const row = {
      ...base,
      owner: "Avery Carter",
      ownerAvatarUrl: OWNER_AVATAR_URL,
    };

    render(
      renderApprovedBranchCell("owner", row, REPOSITORY_LABELS, undefined, true)
    );

    expect(screen.getByText("Avery Carter")).toBeInTheDocument();
    expect(
      document.querySelector('img[data-slot="avatar-image"]')
    ).toHaveAttribute("src", OWNER_AVATAR_URL);
    expect(screen.queryByText("A")).not.toBeInTheDocument();
  });
});
