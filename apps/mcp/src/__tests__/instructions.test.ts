import { DocumentType } from "@repo/api/src/types/document.js";
import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS } from "../instructions.js";
import { TOOL_NAMES } from "../tool-registrations.js";
import { TAG_DOCUMENT_SCOPE_HELP } from "../tools/tag-resolution.js";

/**
 * The server instructions are read before any tool schema, so a promise made
 * here outranks a correction made in a tool description. ISS-6967's incident
 * was an agent reasoning about the product from the surface it was handed —
 * these cases pin the tag paragraph to what the tools can actually do.
 */
describe("SERVER_INSTRUCTIONS tag guidance", () => {
  it("scopes the tag write tools to documents", () => {
    expect(SERVER_INSTRUCTIONS).toContain("group DOCUMENTS across projects");
    expect(SERVER_INSTRUCTIONS).toContain("target documents only");
  });

  it("does not promise that the MCP tools can tag a project", () => {
    // `tag-artifact` and `untag-artifact` both resolve their target through
    // GET /documents/{id}, so a PRO-* slug fails. The instructions must not
    // read as if projects were a valid target, which is what "applied across
    // projects and documents" did.
    expect(SERVER_INSTRUCTIONS).not.toContain(
      "applied across projects and documents"
    );
    expect(SERVER_INSTRUCTIONS).toContain(
      "`PRO-*` project is not a valid target"
    );
  });

  it("agrees with the scope sentence the tools themselves carry", () => {
    // Both statements come from this repo, so they can drift apart silently.
    // The tool-side constant is the one an agent sees at call time.
    expect(TAG_DOCUMENT_SCOPE_HELP).toContain("Documents only");
    expect(TAG_DOCUMENT_SCOPE_HELP).toContain("projects are not supported");
  });
});

describe("SERVER_INSTRUCTIONS create-document guidance (ISS-10984)", () => {
  it("tells a DOC create it needs no projectId", () => {
    // A DOC needs no project, so an unconditional "always attach via projectId"
    // would send an agent looking for one it does not need.
    expect(SERVER_INSTRUCTIONS).toContain(
      `An organization-level document (\`type: ${DocumentType.Doc}\`) needs no \`projectId\`.`
    );
  });
});

describe("SERVER_INSTRUCTIONS tool references (ISS-12435)", () => {
  it("names only tools this server registers", () => {
    // The loop tools were removed with their instructions; a sentence left
    // pointing an agent at a tool that no longer exists fails here.
    const referenced = [...SERVER_INSTRUCTIONS.matchAll(BACKTICKED_TOOL_NAME)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);

    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((name) => !TOOL_NAMES.includes(name))).toEqual([]);
  });
});

const BACKTICKED_TOOL_NAME = /`([a-z]+(?:-[a-z]+)+)`/g;
