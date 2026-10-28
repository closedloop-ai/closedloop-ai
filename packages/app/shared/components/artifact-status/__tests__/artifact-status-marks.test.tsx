import { DocumentStatus } from "@closedloop-ai/loops-api/document";
import {
  ARTIFACT_STATUS_DETAIL,
  DISPLAYED_ARTIFACT_STATUS,
} from "@repo/api/src/types/artifact-status";
import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import {
  ARTIFACT_STATUS_DETAIL_LABELS,
  ARTIFACT_STATUS_DISPLAY_LABELS,
  LEGACY_UNKNOWN_STATUS_ICON_LABEL,
  UNKNOWN_ARTIFACT_STATUS_DISPLAY,
} from "@repo/api/src/types/artifact-status-display";
import {
  toArtifactStatusFromDocument,
  toArtifactStatusFromSession,
} from "@repo/api/src/types/artifact-status-mapping";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import type { ArtifactStatusView } from "@repo/app/shared/lib/artifact-status-view-contract";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

// A value a newer build persisted that this one's Document fold cannot place.
const UNRECOGNIZED_RAW_STATUS = "BRANCH_MERGED";

const UNRECOGNIZED_VIEW: ArtifactStatusView = {
  artifactId: "doc-1",
  normalized: toArtifactStatusFromDocument(UNRECOGNIZED_RAW_STATUS),
  raw: UNRECOGNIZED_RAW_STATUS,
  vocabulary: ArtifactStatusVocabulary.Document,
};

describe("the champion's answer for a status it cannot place", () => {
  it("names the unknown status in full when ISS-9560's gate is open", () => {
    renderWithLabelHonesty(
      <ArtifactStatus
        variant={ArtifactStatusVariant.Icon}
        view={UNRECOGNIZED_VIEW}
      />
    );

    // The icon variant has no visible text, so this name is the reader's ONLY
    // statement of the value. Falling back to a per-vocabulary adapter, or to
    // the field word, fails here.
    expect(
      screen.getByLabelText(UNKNOWN_ARTIFACT_STATUS_DISPLAY.accessibleName)
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(LEGACY_UNKNOWN_STATUS_ICON_LABEL)
    ).not.toBeInTheDocument();
  });

  it("draws it with a different mark from a status this build CAN place", () => {
    // The word is half the answer; a reader scanning a column reads the mark.
    // Resolving an unplaceable status to a real one's glyph would let it pass
    // for a measured outcome, which is what the muted marker exists to stop.
    // ONE recognized status is the comparison, not all of them: what this pins
    // is that the resolved appearance reaches the glyph at all. Which row the
    // resolver selects is `shared/lib/__tests__/artifact-status-appearance.test.ts`.
    const unrecognized = render(
      <ArtifactStatus
        variant={ArtifactStatusVariant.Icon}
        view={UNRECOGNIZED_VIEW}
      />
    );
    // The SVG's own attributes carry the accessible name, which already differs
    // and would make this pass on two identical glyphs. Its CONTENT is the
    // drawing, and the drawing is the claim.
    const unrecognizedMark = markGeometry(unrecognized.container);
    unrecognized.unmount();

    const recognized = render(
      <ArtifactStatus
        variant={ArtifactStatusVariant.Icon}
        view={{
          artifactId: "doc-3",
          normalized: toArtifactStatusFromDocument(DocumentStatus.Draft),
          raw: DocumentStatus.Draft,
          vocabulary: ArtifactStatusVocabulary.Document,
        }}
      />
    );

    expect(markGeometry(recognized.container)).not.toBe(unrecognizedMark);
  });

  it("still names the status WORD with the gate shut", () => {
    render(
      <ArtifactStatus
        variant={ArtifactStatusVariant.Icon}
        view={UNRECOGNIZED_VIEW}
      />
    );

    // UAS-007 is not gated: the closed default drops the explanatory sentence,
    // never the word. "Status" names the FIELD and tells a reader nothing.
    expect(
      screen.getByLabelText(ARTIFACT_STATUS_DISPLAY_LABELS.unknown)
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(LEGACY_UNKNOWN_STATUS_ICON_LABEL)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(UNRECOGNIZED_RAW_STATUS)).not.toBeInTheDocument();
  });

  // ISS-10364 (operator ruling, 2026-09-23/24) retired `stale` and `unknown`
  // from the session vocabulary, so `SESSION_STATUS_MAPPING` no longer has a
  // row for either — both are plain literals now, and both fold through the
  // generic unrecognized-value path to the SAME undetailed unknown root. The
  // "DETAILED unknown root" distinction this file used to pin for `stale`
  // (a mapped root with its own word and mark, byte-for-byte the shape a true
  // fold miss produces) no longer exists for ANY vocabulary — the earlier
  // `artifact-status-mapping.test.ts` pins that no table row carries the
  // unknown root at all any more. Kept as one case instead of two.
  it.each(["stale", "unknown"])(
    "folds a retired/unrecognized session spelling (%s) to the generic unknown root",
    (raw) => {
      renderWithLabelHonesty(
        <ArtifactStatus
          variant={ArtifactStatusVariant.Icon}
          view={{
            artifactId: "session-1",
            normalized: toArtifactStatusFromSession(raw),
            raw,
            vocabulary: ArtifactStatusVocabulary.Session,
          }}
        />
      );

      expect(
        screen.getByLabelText(UNKNOWN_ARTIFACT_STATUS_DISPLAY.accessibleName)
      ).toBeInTheDocument();
    }
  );

  it("offers no explanation for a row that stored no status at all", () => {
    // The case identity alone cannot see: a null `raw` folds to the very same
    // singleton a rejected value does, so the check that tells a version skew
    // from a measured answer cannot also tell it from an empty column. There is
    // no status here to fail to recognize, and an upgrade would not add one.
    renderWithLabelHonesty(
      <ArtifactStatus
        variant={ArtifactStatusVariant.Icon}
        view={{
          artifactId: "doc-2",
          normalized: toArtifactStatusFromDocument(null),
          raw: null,
          vocabulary: ArtifactStatusVocabulary.Document,
        }}
      />
    );

    expect(
      screen.getByLabelText(ARTIFACT_STATUS_DISPLAY_LABELS.unknown)
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText(UNKNOWN_ARTIFACT_STATUS_DISPLAY.accessibleName)
    ).not.toBeInTheDocument();
  });
});

describe("a detail produced by another vocabulary", () => {
  it("degrades the WORD to the root, as the mark already degrades", () => {
    // A caller pairing the wrong fold with the right vocabulary is what the
    // registry's ownership check exists for. The mark falls back to the root;
    // a label read straight from the detail table would print "Approved" beside
    // the root's marker and state an outcome for a row nothing measured.
    render(
      <ArtifactStatus
        variant={ArtifactStatusVariant.Display}
        view={{
          artifactId: "session-2",
          normalized: toArtifactStatusFromDocument(DocumentStatus.Approved),
          raw: DocumentStatus.Approved,
          vocabulary: ArtifactStatusVocabulary.Session,
        }}
      />
    );

    expect(
      screen.getByText(ARTIFACT_STATUS_DISPLAY_LABELS.done)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        ARTIFACT_STATUS_DETAIL_LABELS[ARTIFACT_STATUS_DETAIL.DocumentApproved]
      )
    ).not.toBeInTheDocument();
  });

  it("renders the universal root before the detail its vocabulary produced", () => {
    const approved = render(
      <ArtifactStatus
        variant={ArtifactStatusVariant.Display}
        view={{
          artifactId: "doc-2",
          normalized: toArtifactStatusFromDocument(DocumentStatus.Approved),
          raw: DocumentStatus.Approved,
          vocabulary: ArtifactStatusVocabulary.Document,
        }}
      />
    );

    expect(
      screen.getByText(ARTIFACT_STATUS_DISPLAY_LABELS.done)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        ARTIFACT_STATUS_DETAIL_LABELS[ARTIFACT_STATUS_DETAIL.DocumentApproved]
      )
    ).toBeInTheDocument();

    const approvedMark = markGeometry(approved.container);
    approved.unmount();
    const rootOnly = render(
      <ArtifactStatus
        variant={ArtifactStatusVariant.Display}
        view={{
          artifactId: "issue-1",
          normalized: { root: DISPLAYED_ARTIFACT_STATUS.Done },
          raw: "DONE",
          vocabulary: ArtifactStatusVocabulary.Issue,
        }}
      />
    );

    // Document Approved used to draw its detail-specific full ring. A row now
    // draws the universal Done mark; detail remains text, never a second visual
    // state axis.
    expect(markGeometry(rootOnly.container)).toBe(approvedMark);
  });

  it("gives an icon-only row the complete root and detail value", () => {
    render(
      <ArtifactStatus
        variant={ArtifactStatusVariant.Icon}
        view={{
          artifactId: "doc-2",
          normalized: toArtifactStatusFromDocument(DocumentStatus.Approved),
          raw: DocumentStatus.Approved,
          vocabulary: ArtifactStatusVocabulary.Document,
        }}
      />
    );

    expect(screen.getByLabelText("Done, Approved")).toBeInTheDocument();
  });
});

function markGeometry(container: HTMLElement): string {
  const svg = container.querySelector("svg");
  if (svg === null) {
    throw new Error("the icon variant rendered no mark at all");
  }
  return svg.innerHTML;
}

function renderWithLabelHonesty(ui: ReactNode) {
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
