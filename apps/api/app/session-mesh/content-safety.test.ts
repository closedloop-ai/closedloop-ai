import { describe, expect, it } from "vitest";
import { sanitizeMeshContext, sanitizeMeshText } from "./content-safety";

describe("Session Mesh evidence redaction", () => {
  it("redacts secrets in summaries, nested evidence and object keys", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const context = {
      decisions: [`Use the service; token=${token}`],
      evidence: {
        [token]: { text: `Authorization: Bearer ${"b".repeat(40)}` },
      },
    };
    const output = JSON.stringify(sanitizeMeshContext(context));
    expect(output).not.toContain(token);
    expect(output).not.toContain("b".repeat(40));
    expect(output).toContain("REDACTED");
    expect(sanitizeMeshText(`Key ${token}`)).not.toContain(token);
    expect(context.decisions[0]).toContain(token);
  });

  it("does not persist transcript or credential containers under spelling aliases", () => {
    expect(
      sanitizeMeshContext({
        raw_transcript: "private transcript",
        messages: [{ role: "user", content: "private transcript" }],
        evidence: {
          accessToken: "opaque",
          "private-key": "opaque",
          path: "src/a.ts",
        },
        decisions: ["Reuse the public API"],
      })
    ).toEqual({
      evidence: { path: "src/a.ts" },
      decisions: ["Reuse the public API"],
    });
  });

  it("preserves bounded ordinary evidence and is idempotent", () => {
    const context = {
      schemaVersion: 1,
      complete: false,
      evidence: [null, "src/a.ts:12"],
    };
    expect(sanitizeMeshContext(context)).toEqual(context);
    expect(sanitizeMeshContext(sanitizeMeshContext(context))).toEqual(context);
  });
});
