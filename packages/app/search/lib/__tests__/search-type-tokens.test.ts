import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { describe, expect, it } from "vitest";
import {
  activeTypeKinds,
  addTypeToken,
  removeTypeToken,
  toggleTypeToken,
} from "../search-type-tokens";

describe("search-type-tokens (FEA-4134)", () => {
  it("reads active type: kinds via the canonical parser, deduped in order", () => {
    expect(
      activeTypeKinds("agent type:document type:loop type:document")
    ).toEqual([SearchEntityType.Document, SearchEntityType.Loop]);
  });

  it("ignores an unknown type: value (matches the parser)", () => {
    expect(activeTypeKinds("type:widget type:loop")).toEqual([
      SearchEntityType.Loop,
    ]);
  });

  it("returns no kinds for a query with no type: token", () => {
    expect(activeTypeKinds("just words status:DONE")).toEqual([]);
  });

  it("appends a type: token when absent", () => {
    expect(addTypeToken("agent", SearchEntityType.Loop)).toBe(
      "agent type:loop"
    );
  });

  it("does not duplicate an already-present type: token", () => {
    expect(addTypeToken("agent type:loop", SearchEntityType.Loop)).toBe(
      "agent type:loop"
    );
  });

  it("removes every matching type: token, case-insensitively", () => {
    expect(
      removeTypeToken("agent type:Loop other type:loop", SearchEntityType.Loop)
    ).toBe("agent other");
  });

  it("removes the equality-operator type= form the parser also marks active", () => {
    // The canonical parser treats `type=loop` as an active Loop filter, so the
    // control must be able to deselect it — matching only `type:` would strand
    // it as un-removable.
    expect(activeTypeKinds("agent type=loop")).toEqual([SearchEntityType.Loop]);
    expect(removeTypeToken("agent type=loop", SearchEntityType.Loop)).toBe(
      "agent"
    );
    expect(toggleTypeToken("agent type=loop", SearchEntityType.Loop)).toBe(
      "agent"
    );
  });

  it("toggles a type: token off when present", () => {
    expect(toggleTypeToken("agent type:loop", SearchEntityType.Loop)).toBe(
      "agent"
    );
  });

  it("toggles a type: token on when absent", () => {
    expect(toggleTypeToken("agent", SearchEntityType.Document)).toBe(
      "agent type:document"
    );
  });

  it("round-trips the mouse-first control: toggle on then off restores the free text", () => {
    const start = "agent status:DONE";
    const on = toggleTypeToken(start, SearchEntityType.AgentSession);
    expect(activeTypeKinds(on)).toEqual([SearchEntityType.AgentSession]);
    const off = toggleTypeToken(on, SearchEntityType.AgentSession);
    expect(activeTypeKinds(off)).toEqual([]);
    expect(off).toBe(start);
  });
});
