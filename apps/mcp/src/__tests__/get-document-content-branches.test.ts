import { describe, expect, it, vi } from "vitest";
import { registerGetDocumentContent } from "../tools/get-document-content.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

const DOCUMENT_ID = "019c2991-0bce-76bc-bc7e-a4750929f668";
const OTHER_DOCUMENT_ID = "019c2991-0bce-76bc-bc7e-a4750929f669";

function documentResponse(id: string, content = "abcdef") {
  return { id, version: { documentId: id, version: 1, content } };
}

function makeHandler(get: ReturnType<typeof vi.fn>) {
  return createToolHarness(registerGetDocumentContent, { get } as never);
}

describe("get-document-content selector guards", () => {
  it("rejects an empty documentId before calling the API", async () => {
    const get = vi.fn();
    const handler = makeHandler(get);

    const result = await handler({ documentId: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("documentId must not be empty");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a cursor whose base64url is not canonical", async () => {
    // "AB" decodes to one 0x00 byte whose re-encoding is "AA".
    const get = vi.fn();
    const handler = makeHandler(get);

    const result = await handler({ documentId: "ISS-42", cursor: "AB" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Continuation cursor is not canonical base64url"
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a continuation when the same version number now resolves to a different document", async () => {
    let response = documentResponse(DOCUMENT_ID);
    const get = vi.fn(() => Promise.resolve(response));
    const handler = makeHandler(get);
    const first = parseToolPayload(
      await handler({ documentId: "ISS-42", chunkSizeBytes: 2 })
    ) as { nextCursor: string };

    response = documentResponse(OTHER_DOCUMENT_ID);
    const result = await handler({
      documentId: "ISS-42",
      cursor: first.nextCursor,
    });

    expect(get).toHaveBeenLastCalledWith("/documents/ISS-42", {
      version: "1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Continuation cursor document id does not match the freshly resolved document"
    );
  });
});
