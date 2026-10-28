/**
 * @file trace-comment-write-payload-strip.test.ts
 * @description ISS-5608 — pins the STRIP-vs-REJECT outcome of the four trace/
 * document comment WRITE schemas, the behaviour that makes the keys-covered
 * guards added alongside this file the only defence those boundaries have.
 *
 * All four are `z.ZodType<T>`-annotated plain `z.object`s over independently
 * declared wire types. That combination is silent in both directions:
 * `z.ZodType<T>` is covariant in its output, so the annotation alone lets a
 * schema omit an optional key of `T` with no error, and a plain `z.object`
 * STRIPS the untaught key at runtime instead of rejecting it. A field added to
 * `TraceCommentDraft` but never taught to `traceCommentDraftSchema` therefore
 * disappears from every POST body before persistence — the comment is created
 * without it and the client is handed a 201 — and on the update path an edit
 * reports success while silently not taking.
 *
 * Deliberately NOT re-asserted here, because it is already covered through these
 * same schemas: `mentions` handling (`trace-comment-mentions.test.ts`) and
 * version-skewed `kind` degradation (`trace-comment-draft-kind.test.ts`).
 */
import { describe, expect, it } from "vitest";
import type {
  DocumentThreadReplyDraft,
  TraceCommentDraft,
  TraceCommentReplyDraft,
  TraceCommentUpdate,
} from "../comment";
import {
  documentThreadReplyDraftSchema,
  traceCommentDraftSchema,
  traceCommentReplyDraftSchema,
  traceCommentUpdateSchema,
} from "../comment";

const ANCHOR: TraceCommentDraft["anchor"] = {
  traceId: "trace-5608",
  turnId: "turn-001",
  row: 3,
  selectedText: "dropped",
  sourceText: "the collector dropped it",
  startOffset: 14,
  endOffset: 21,
};

/**
 * One valid payload per write schema, written out LITERALLY rather than derived
 * from the schema it is checked against — a fixture that asks the schema what it
 * knows agrees with the schema by construction and stays green when a key is
 * removed from it.
 */
const DRAFT: TraceCommentDraft = {
  anchor: ANCHOR,
  body: "the projection dropped the footprint",
  mentions: ["user-a", "user-b"],
  clientId: "local-row-91",
};

const REPLY: TraceCommentReplyDraft = {
  body: "confirmed on the desktop side too",
  mentions: ["user-c"],
  clientId: "local-row-92",
};

const UPDATE: TraceCommentUpdate = {
  body: "edited: the projection dropped the footprint",
  mentions: ["user-a"],
};

const DOCUMENT_REPLY: DocumentThreadReplyDraft = {
  body: "acknowledged on the plan",
};

describe("ISS-5608: trace comment write payloads strip untaught keys", () => {
  it("accepts each payload and returns its taught keys unchanged", () => {
    // The positive sibling for the strip assertion below. Without it, "the
    // unknown key is gone" is equally satisfied by a schema that drops
    // everything, or by one that rejects and never returns at all.
    expect(traceCommentDraftSchema.parse(DRAFT)).toEqual(DRAFT);
    expect(traceCommentReplyDraftSchema.parse(REPLY)).toEqual(REPLY);
    expect(traceCommentUpdateSchema.parse(UPDATE)).toEqual(UPDATE);
    expect(documentThreadReplyDraftSchema.parse(DOCUMENT_REPLY)).toEqual(
      DOCUMENT_REPLY
    );
  });

  it("SILENTLY DROPS an untaught key rather than rejecting the write", () => {
    // `attachmentIds` stands in for the next field added to one of these wire
    // types. The parse succeeds — no error reaches the route, the caller sees a
    // 2xx — and the key is simply not in the persisted payload. Nothing at
    // runtime can report this, which is the entire argument for the
    // `satisfies Record<keyof T, z.ZodTypeAny>` guards on these shapes.
    const untaught = { attachmentIds: ["file-1"] };

    const parsedDraft = traceCommentDraftSchema.parse({
      ...DRAFT,
      ...untaught,
    });
    expect(parsedDraft).toEqual(DRAFT);
    expect(Object.hasOwn(parsedDraft, "attachmentIds")).toBe(false);

    const parsedReply = traceCommentReplyDraftSchema.parse({
      ...REPLY,
      ...untaught,
    });
    expect(parsedReply).toEqual(REPLY);

    // The edit path is the same mechanism with a different consequence: the
    // user is told the edit landed while the untaught field never persisted.
    const parsedUpdate = traceCommentUpdateSchema.parse({
      ...UPDATE,
      ...untaught,
    });
    expect(parsedUpdate).toEqual(UPDATE);

    const parsedDocumentReply = documentThreadReplyDraftSchema.parse({
      ...DOCUMENT_REPLY,
      ...untaught,
    });
    expect(parsedDocumentReply).toEqual(DOCUMENT_REPLY);
  });

  it("keeps absent optionals OMITTED rather than materializing them", () => {
    // Every optional on these payloads is `?: T` with no `| null`, so absence
    // must stay absence: an older client that predates mentions/clientId must
    // not have them appear as `null` or `[]` on the persisted row.
    //
    // Asserted on the reply and the update as well as the draft, because the
    // tempting change is to `.default([])` on `mentions` — the READ type
    // (`TraceCommentReply.mentions`) already documents consumers normalizing a
    // missing value to an empty array, so unifying the two is a plausible move.
    // A draft-only assertion would stay green through exactly that.
    const minimalDraft = traceCommentDraftSchema.parse({
      anchor: ANCHOR,
      body: "no optionals at all",
    });
    expect(Object.hasOwn(minimalDraft, "mentions")).toBe(false);
    expect(Object.hasOwn(minimalDraft, "clientId")).toBe(false);
    expect(Object.hasOwn(minimalDraft, "kind")).toBe(false);

    const minimalReply = traceCommentReplyDraftSchema.parse({
      body: "no optionals at all",
    });
    expect(Object.hasOwn(minimalReply, "mentions")).toBe(false);
    expect(Object.hasOwn(minimalReply, "clientId")).toBe(false);

    const minimalUpdate = traceCommentUpdateSchema.parse({
      body: "no optionals at all",
    });
    expect(Object.hasOwn(minimalUpdate, "mentions")).toBe(false);
  });
});
