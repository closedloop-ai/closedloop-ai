/**
 * @file agent-component-invocation-session-tree.test.ts
 * @description Pins the session-tree completeness bound and the cursor codec
 * -- the two pure pieces of ISS-10737's session-scoped invocation read.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SESSION_TREE_MAX_PAGES,
  agentComponentInvocationSessionTreeBound,
  decodeAgentComponentInvocationSessionTreeCursor,
  encodeAgentComponentInvocationSessionTreeCursor,
} from "./agent-component-invocation-session-tree.ts";

describe("agentComponentInvocationSessionTreeBound", () => {
  it("reports a complete walk as untruncated with zero dropped", () => {
    expect(agentComponentInvocationSessionTreeBound(10, 10)).toEqual({
      maxPages: AGENT_COMPONENT_INVOCATION_SESSION_TREE_MAX_PAGES,
      droppedCount: 0,
      truncated: false,
    });
  });

  it("reports a short walk as truncated with the exact shortfall", () => {
    expect(agentComponentInvocationSessionTreeBound(10, 4)).toEqual({
      maxPages: AGENT_COMPONENT_INVOCATION_SESSION_TREE_MAX_PAGES,
      droppedCount: 6,
      truncated: true,
    });
  });

  it("clamps a gathered count above total to zero dropped rather than negative", () => {
    // total and gathered are separate reads; a row inserted between them must
    // not be published as a negative "dropped" count.
    expect(agentComponentInvocationSessionTreeBound(5, 8)).toEqual({
      maxPages: AGENT_COMPONENT_INVOCATION_SESSION_TREE_MAX_PAGES,
      droppedCount: 0,
      truncated: false,
    });
  });

  it("accepts an explicit maxPages override instead of the default constant", () => {
    expect(agentComponentInvocationSessionTreeBound(20, 5, 3)).toEqual({
      maxPages: 3,
      droppedCount: 15,
      truncated: true,
    });
  });
});

describe("agent-component-invocation-session-tree cursor codec", () => {
  const cursor = {
    sequence: 42,
    externalInvocationId: "ext-123",
    id: "row-abc",
  };

  it("round-trips an encoded cursor back to its original fields", () => {
    const encoded = encodeAgentComponentInvocationSessionTreeCursor(cursor);
    expect(decodeAgentComponentInvocationSessionTreeCursor(encoded)).toEqual(
      cursor
    );
  });

  // Pins current behavior. Looks odd: encode accepts the codec's own separator
  // inside externalInvocationId, so the token splits into four parts and the
  // decode refuses it, which means that page cannot be resumed.
  it("encodes an id holding the separator into a token decode refuses", () => {
    const encoded = encodeAgentComponentInvocationSessionTreeCursor({
      ...cursor,
      externalInvocationId: `ext${String.fromCharCode(31)}123`,
    });
    expect(decodeAgentComponentInvocationSessionTreeCursor(encoded)).toBeNull();
  });

  it("returns null for null, undefined, and empty-string input", () => {
    expect(decodeAgentComponentInvocationSessionTreeCursor(null)).toBeNull();
    expect(
      decodeAgentComponentInvocationSessionTreeCursor(undefined)
    ).toBeNull();
    expect(decodeAgentComponentInvocationSessionTreeCursor("")).toBeNull();
  });

  it("returns null for a token that does not decode to three segments", () => {
    const tooFew = Buffer.from("1", "utf8").toString("base64url");
    const tooMany = Buffer.from("1\u001f2\u001f3\u001f4", "utf8").toString(
      "base64url"
    );
    expect(decodeAgentComponentInvocationSessionTreeCursor(tooFew)).toBeNull();
    expect(decodeAgentComponentInvocationSessionTreeCursor(tooMany)).toBeNull();
  });

  it("returns null when the sequence segment is not a safe integer", () => {
    const raw = ["not-a-number", "ext-1", "row-1"].join("\u001f");
    const encoded = Buffer.from(raw, "utf8").toString("base64url");
    expect(decodeAgentComponentInvocationSessionTreeCursor(encoded)).toBeNull();
  });

  it("returns null when externalInvocationId is an empty segment", () => {
    const raw = ["1", "", "row-1"].join("\u001f");
    const encoded = Buffer.from(raw, "utf8").toString("base64url");
    expect(decodeAgentComponentInvocationSessionTreeCursor(encoded)).toBeNull();
  });

  it("returns null when id is an empty segment", () => {
    const raw = ["1", "ext-1", ""].join("\u001f");
    const encoded = Buffer.from(raw, "utf8").toString("base64url");
    expect(decodeAgentComponentInvocationSessionTreeCursor(encoded)).toBeNull();
  });

  it("decodes a sequence of exactly zero, not treated as falsy-missing", () => {
    const raw = ["0", "ext-1", "row-1"].join("\u001f");
    const encoded = Buffer.from(raw, "utf8").toString("base64url");
    expect(decodeAgentComponentInvocationSessionTreeCursor(encoded)).toEqual({
      sequence: 0,
      externalInvocationId: "ext-1",
      id: "row-1",
    });
  });
});
