// ISS-10397: the two parsers in the /mcp handshake that break first when
// addon-mcp changes its docs-list format or its Streamable-HTTP transport.
import { describe, expect, it } from "vitest";
import { findProbeIds, parseRpcReply } from "../scripts/mcp-handshake.mjs";

const NOT_LISTED = /does not list Button/;
const NO_STORY_IDS = /with no story ids/;

describe("findProbeIds", () => {
  it("reads the Button component id and its first story id from docs-list", () => {
    const list = [
      "# Components",
      "- Badge (design-system-badge): A status label",
      "  - Default (design-system-badge--default)",
      "- Button (design-system-button): The primary action",
      "  - Default (design-system-button--default)",
      "  - Secondary (design-system-button--secondary)",
    ].join("\n");

    expect(findProbeIds(list)).toEqual({
      componentId: "design-system-button",
      storyId: "design-system-button--default",
    });
  });

  it("fails when docs-list does not list Button", () => {
    expect(() =>
      findProbeIds("- Badge (design-system-badge)\n  - Default (x--default)")
    ).toThrow(NOT_LISTED);
  });

  it("fails when Button is listed without story ids", () => {
    expect(() =>
      findProbeIds("- Button (design-system-button): no stories\n- Badge (b)")
    ).toThrow(NO_STORY_IDS);
  });
});

describe("parseRpcReply", () => {
  const reply = { jsonrpc: "2.0", id: 1, result: { tools: [] } };

  it("parses a plain JSON body", () => {
    expect(parseRpcReply(JSON.stringify(reply), "application/json")).toEqual(
      reply
    );
  });

  it("takes the last data: line of an SSE body", () => {
    const body = [
      "event: message",
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
      "",
      "event: message",
      `data: ${JSON.stringify(reply)}`,
      "",
    ].join("\n");

    expect(parseRpcReply(body, "text/event-stream; charset=utf-8")).toEqual(
      reply
    );
  });

  it("returns undefined for an empty body", () => {
    expect(parseRpcReply("", "application/json")).toBeUndefined();
    expect(
      parseRpcReply("event: message\n\n", "text/event-stream")
    ).toBeUndefined();
  });
});
