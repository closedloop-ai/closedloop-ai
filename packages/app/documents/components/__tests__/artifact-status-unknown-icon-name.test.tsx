import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { DocumentStatusIcon } from "../document-status-icon";
import { IssueStatusIcon } from "../issue-status-icon";

/**
 * ISS-9560, the LABEL half. ISS-9557 already gave an unrecognized status the
 * `blank-ring` this vocabulary never claims, so what remained was the name: both
 * icons announced the literal word "Status", which names the FIELD and says
 * nothing about its value. These are icon-only controls, so the accessible name
 * is their ONLY statement of the status.
 *
 * The expected strings below are a HAND-WRITTEN ORACLE, deliberately. Reading
 * them back out of `artifact-status-display` — the module the icons resolve them
 * from — would make every assertion here tautological: the sentence could be
 * replaced with garbage and the suite would stay green. Same reasoning the
 * caption oracles in `shared/test-fixtures/documents.ts` are written out by
 * hand.
 */
const UNKNOWN_ICON_NAME =
  "Unknown, This app version does not recognize this artifact's status. The work may still be in progress.";
const LEGACY_ICON_NAME = "Status";

// Reachable from persisted or wire data: `Artifact.status` is a freeform column
// carrying two disjoint vocabularies, and `my-tasks-kanban.tsx` casts it into
// these typed props.
const UNRECOGNIZED_STATUS = "BRANCH_MERGED";

function gated(ui: ReactElement) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY],
      })}
    >
      {ui}
    </FeatureFlagAdapterProvider>
  );
}

function accessibleName(container: HTMLElement): string | null {
  const svg = container.querySelector("svg");
  if (!svg) {
    throw new Error("expected an svg to render");
  }
  return svg.getAttribute("aria-label");
}

describe("the status icons' name for a status this build does not recognize", () => {
  it("names it Unknown, with the sentence, on a Document icon when the gate is open", () => {
    const { container } = gated(
      <DocumentStatusIcon status={UNRECOGNIZED_STATUS as DocumentStatus} />
    );

    expect(accessibleName(container)).toBe(UNKNOWN_ICON_NAME);
  });

  it("names it Unknown, with the sentence, on an Issue icon when the gate is open", () => {
    const { container } = gated(
      <IssueStatusIcon status={UNRECOGNIZED_STATUS as IssueStatus} />
    );

    expect(accessibleName(container)).toBe(UNKNOWN_ICON_NAME);
  });

  it("leaves a recognized status alone when the gate is open", () => {
    // The gate changes the MISS path only — the words for a status the build
    // does know must be untouched by it.
    expect(
      accessibleName(
        gated(<DocumentStatusIcon status={DocumentStatus.Draft} />).container
      )
    ).toBe("Draft");
    expect(
      accessibleName(
        gated(<IssueStatusIcon status={IssueStatus.Todo} />).container
      )
    ).toBe("Todo");
  });

  it("keeps the pre-flag name while the gate is shut", () => {
    // ISS-4779 closed-by-default: with no adapter mounted the optional read
    // resolves false, which is the same answer a signed-in user without the flag
    // gets. Both icons must still be exactly as they shipped.
    expect(
      accessibleName(
        render(
          <DocumentStatusIcon status={UNRECOGNIZED_STATUS as DocumentStatus} />
        ).container
      )
    ).toBe(LEGACY_ICON_NAME);
    expect(
      accessibleName(
        render(<IssueStatusIcon status={UNRECOGNIZED_STATUS as IssueStatus} />)
          .container
      )
    ).toBe(LEGACY_ICON_NAME);
  });
});
