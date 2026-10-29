import { describe, expect, it } from "vitest";
import type { TraceTextAnchor } from "../comment";
import {
  COMMENT_ANCHOR_SCHEMA_VERSION,
  CodeCommentSide,
  type CommentAnchor,
  type CommentAnchorByKind,
  commentAnchorSchema,
  parseStoredCommentAnchor,
  StoredCommentAnchorReadStatus,
  storedCommentAnchorSchema,
  toStoredCommentAnchor,
  traceTextAnchorToCommentAnchor,
} from "../comment-anchor";
import { CommentAnchorKind } from "../comment-anchor-kind";

const MAXIMAL_TRACE: TraceTextAnchor = {
  traceId: "trace-9f2c",
  turnId: "turn-004",
  row: 12,
  selectedText: "the collector dropped the session",
  sourceText: "…and then the collector dropped the session on retry…",
  startOffset: 8,
  endOffset: 41,
  sessionId: "sess-7731",
  actor: { name: "claude", human: "marisol" },
};

const NULLED_TRACE: TraceTextAnchor = {
  ...MAXIMAL_TRACE,
  sessionId: null,
  actor: null,
};

const ANCHORS: CommentAnchorByKind = {
  [CommentAnchorKind.Artifact]: { kind: CommentAnchorKind.Artifact },
  [CommentAnchorKind.Text]: {
    kind: CommentAnchorKind.Text,
    documentVersion: 3,
    quote: { exact: "delivery boundary", prefix: "the ", suffix: " is" },
    position: { start: 10, end: 27 },
  },
  [CommentAnchorKind.Trace]: traceTextAnchorToCommentAnchor(MAXIMAL_TRACE),
  [CommentAnchorKind.Code]: {
    kind: CommentAnchorKind.Code,
    repository: "acme/widgets",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    path: "src/index.ts",
    side: CodeCommentSide.Right,
    startLine: 4,
    startSide: CodeCommentSide.Right,
    endLine: 9,
    originalEndLine: 8,
  },
  [CommentAnchorKind.Prototype]: {
    kind: CommentAnchorKind.Prototype,
    prototypeVersionId: "pv-1",
    route: "/checkout",
    anchorId: "cta",
    selector: "[data-anchor=cta]",
    domPath: "main > button",
    textContext: "Pay now",
    normalizedPosition: { x: 0.4, y: 0.6 },
    originalRect: { x: 10, y: 20, width: 120, height: 40 },
    viewport: { width: 1280, height: 800 },
  },
};

const ALL_ANCHORS: CommentAnchor[] = Object.values(ANCHORS);

function withField(
  anchor: CommentAnchor,
  field: string,
  value: unknown
): Record<string, unknown> {
  return { ...anchor, [field]: value };
}

describe("commentAnchorSchema", () => {
  it.each(ALL_ANCHORS)("accepts a valid $kind anchor unchanged", (anchor) => {
    expect(commentAnchorSchema.parse(anchor)).toEqual(anchor);
  });

  it("accepts an outdated code anchor whose endLine is null", () => {
    const outdated = withField(ANCHORS.code, "endLine", null);

    expect(commentAnchorSchema.parse(outdated)).toEqual(outdated);
  });

  it("accepts a code range whose start sits on the other side above endLine", () => {
    const crossSide = {
      ...ANCHORS.code,
      startSide: CodeCommentSide.Left,
      startLine: 12,
      endLine: 9,
    };

    expect(commentAnchorSchema.parse(crossSide)).toEqual(crossSide);
  });

  it.each([
    ["trace endOffset < startOffset", withField(ANCHORS.trace, "endOffset", 7)],
    ["code side outside left/right", withField(ANCHORS.code, "side", "both")],
    [
      "code commitSha not a hex sha",
      withField(ANCHORS.code, "commitSha", "main"),
    ],
    ["code endLine zero", withField(ANCHORS.code, "endLine", 0)],
    [
      "code startLine > endLine on one side",
      withField(ANCHORS.code, "startLine", 10),
    ],
    [
      "code startSide without startLine",
      withField(ANCHORS.code, "startLine", undefined),
    ],
    [
      "text position.end < position.start",
      withField(ANCHORS.text, "position", { start: 9, end: 2 }),
    ],
    [
      "text documentVersion zero",
      withField(ANCHORS.text, "documentVersion", 0),
    ],
    [
      "text empty exact quote",
      withField(ANCHORS.text, "quote", { exact: "", prefix: "", suffix: "" }),
    ],
    [
      "prototype without anchorId",
      withField(ANCHORS.prototype, "anchorId", undefined),
    ],
    ["unknown kind", { kind: "content" }],
    ["missing kind", { path: "a.ts" }],
  ])("rejects %s", (_label, value) => {
    expect(commentAnchorSchema.safeParse(value).success).toBe(false);
  });
});

describe("stored comment anchor envelope", () => {
  it.each(ALL_ANCHORS)(
    "round-trips a $kind anchor through the envelope",
    (anchor) => {
      const stored = toStoredCommentAnchor(anchor);

      expect(stored.v).toBe(COMMENT_ANCHOR_SCHEMA_VERSION);
      expect(storedCommentAnchorSchema.safeParse(stored).success).toBe(true);
      expect(parseStoredCommentAnchor(stored)).toEqual({
        status: StoredCommentAnchorReadStatus.Valid,
        anchor,
      });
    }
  );

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("reads a %s column as absent", (_label, value) => {
    expect(parseStoredCommentAnchor(value)).toEqual({
      status: StoredCommentAnchorReadStatus.Absent,
    });
  });

  it("reads a newer envelope version as unknown_version", () => {
    expect(parseStoredCommentAnchor({ ...ANCHORS.artifact, v: 2 })).toEqual({
      status: StoredCommentAnchorReadStatus.UnknownVersion,
      version: 2,
    });
  });

  it.each([
    ["no envelope version", ANCHORS.artifact],
    ["a current envelope around an invalid anchor", { v: 1, kind: "content" }],
    ["a non-object", "artifact"],
  ])("reads %s as invalid", (_label, value) => {
    expect(parseStoredCommentAnchor(value)).toEqual({
      status: StoredCommentAnchorReadStatus.Invalid,
    });
  });
});

describe("traceTextAnchorToCommentAnchor", () => {
  it.each([
    ["every optional populated", MAXIMAL_TRACE],
    ["nullable optionals set to null", NULLED_TRACE],
  ])("keeps every TraceTextAnchor field with %s", (_label, trace) => {
    const { kind, ...fields } = traceTextAnchorToCommentAnchor(trace);

    expect(kind).toBe(CommentAnchorKind.Trace);
    expect(fields).toEqual(trace);
    expect(
      parseStoredCommentAnchor(
        toStoredCommentAnchor(traceTextAnchorToCommentAnchor(trace))
      )
    ).toEqual({
      status: StoredCommentAnchorReadStatus.Valid,
      anchor: { ...trace, kind: CommentAnchorKind.Trace },
    });
  });
});
