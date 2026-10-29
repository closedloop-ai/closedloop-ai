/**
 * The two type-level refusals in `artifact-status-view-contract.ts` that `tsc`
 * alone does not pin (PRD-714 / ISS-9301).
 *
 * Only negative cases live here. A `@ts-expect-error` fails the typecheck when
 * the thing it rejects starts compiling, which is a real regression guard; an
 * assertion that a derived union has the members it was derived from is that
 * union written twice, and is not.
 */

import { DocumentStatus } from "@closedloop-ai/loops-api/document";
import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import {
  ArtifactStatusEditSurface,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ArtifactStatusEditorProps,
  ArtifactStatusVariant,
  type ArtifactStatusView,
} from "../artifact-status-view-contract";

const VIEW: ArtifactStatusView = {
  artifactId: "01a08d2f-1a65-727e-903d-e99434e66aab",
  normalized: { root: ARTIFACT_STATUS_ROOT.InProgress },
  raw: DocumentStatus.Draft,
  vocabulary: ArtifactStatusVocabulary.Document,
};

describe("ArtifactStatusEditorProps", () => {
  it("refuses a commit whose surface is not the one it was rendered with", () => {
    // Optional-typed, an editor rendered as `detail` could emit a receipt
    // saying `bulk` and typecheck, putting provenance on the record that names
    // an endpoint the write never touched.
    const props: ArtifactStatusEditorProps<
      typeof ArtifactStatusEditSurface.Detail
    > = {
      capability: { editable: true, allowedTargets: [DocumentStatus.Approved] },
      onCommit: () => undefined,
      surface: ArtifactStatusEditSurface.Detail,
      variant: ArtifactStatusVariant.Editor,
      view: VIEW,
    };

    props.onCommit({
      artifactId: VIEW.artifactId,
      from: VIEW.raw,
      // @ts-expect-error — a detail editor cannot emit a bulk receipt.
      surface: ArtifactStatusEditSurface.Bulk,
      to: DocumentStatus.Approved,
      vocabulary: ArtifactStatusVocabulary.Document,
    });

    expect(props.surface).toBe(ArtifactStatusEditSurface.Detail);
  });

  it("cannot be instantiated for a grouped surface", () => {
    // One editor rendered from one `view` can see neither the other selected
    // rows nor the `commitGroupId` they must share, so `bulk` and `board` are
    // refused at the type parameter rather than at the commit. Widening `S`
    // back to the whole union makes both legal and fails `tsc` as two unused
    // directives.
    type BulkEditor = ArtifactStatusEditorProps<
      // @ts-expect-error — `bulk` is a grouped surface.
      typeof ArtifactStatusEditSurface.Bulk
    >;
    type BoardEditor = ArtifactStatusEditorProps<
      // @ts-expect-error — `board` is a grouped surface.
      typeof ArtifactStatusEditSurface.Board
    >;

    expectTypeOf<BulkEditor>().toBeObject();
    expectTypeOf<BoardEditor>().toBeObject();
  });
});
