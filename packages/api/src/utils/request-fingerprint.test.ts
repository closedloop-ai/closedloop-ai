import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeRequestFingerprint } from "./request-fingerprint.ts";

describe("computeRequestFingerprint", () => {
  it("matches an independent sha256 of the canonical form", async () => {
    const expected = createHash("sha256")
      .update('1\u0000update-document\u0000{"documentId":"ISS-1","title":"T"}')
      .digest("hex");

    await expect(
      computeRequestFingerprint("update-document", {
        title: "T",
        documentId: "ISS-1",
      })
    ).resolves.toBe(expected);
  });

  it("gives the MCP server and the transcript the same digest whatever the key order", async () => {
    const fromServer = await computeRequestFingerprint("create-document", {
      title: "Plan",
      projectId: "PRO-1",
      content: "body",
    });
    const fromTranscript = await computeRequestFingerprint("create-document", {
      content: "body",
      projectId: "PRO-1",
      title: "Plan",
    });

    expect(fromTranscript).toBe(fromServer);
  });

  it("separates two tools called with the same arguments", async () => {
    const args = { documentId: "PLN-2191" };

    expect(await computeRequestFingerprint("get-document", args)).not.toBe(
      await computeRequestFingerprint("update-document", args)
    );
  });

  it("separates the same tool called with different arguments", async () => {
    expect(
      await computeRequestFingerprint("update-document", { title: "A" })
    ).not.toBe(
      await computeRequestFingerprint("update-document", { title: "B" })
    );
  });
});
