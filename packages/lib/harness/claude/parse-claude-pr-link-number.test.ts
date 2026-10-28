import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude";

const PR_URL = "https://github.com/closedloop-ai/closedloop-ai/pull/12";
const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "go" },
});

describe("processPrLinkRecord — ISS-7970 PR number guard", () => {
  it("accepts prNumber: 12 without changing the stored ref", async () => {
    const session = await parsePrLink(12);

    expect(session?.prLinks).toEqual([
      {
        number: "12",
        repo: "closedloop-ai/closedloop-ai",
        url: PR_URL,
      },
    ]);
  });

  it("rejects prNumber: 1.5", async () => {
    const session = await parsePrLink(1.5);

    expect(session?.prLinks).toEqual([]);
  });

  it("rejects prNumber: 0", async () => {
    const session = await parsePrLink(0);

    expect(session?.prLinks).toEqual([]);
  });

  it("rejects prNumber: -1", async () => {
    const session = await parsePrLink(-1);

    expect(session?.prLinks).toEqual([]);
  });

  it("rejects a prNumber outside the persisted Prisma Int domain", async () => {
    const session = await parsePrLink(PR_INT_MAX + 1);

    expect(session?.prLinks).toEqual([]);
  });

  it("counts each rejected record in parseQuality so the drop is not silent", async () => {
    const session = await parsePrLink(1.5);

    expect(session?.parseQuality?.malformedPrLinkNumbers).toBe(1);
  });

  it("counts every rejected record, not just the first", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        prLinkLine(1.5, PR_URL),
        prLinkLine(0, `${PR_URL}3`),
        prLinkLine(-1, `${PR_URL}4`),
      ],
      { sessionId: "pr-link-multi" }
    );

    expect(session?.parseQuality?.malformedPrLinkNumbers).toBe(3);
  });

  it("omits the counter entirely when every pr-link record is valid", async () => {
    const session = await parsePrLink(12);

    expect(session?.parseQuality).not.toHaveProperty("malformedPrLinkNumbers");
  });

  it("does not count a pr-link record that carries no numeric prNumber", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        JSON.stringify({
          type: "pr-link",
          timestamp: "2026-07-09T12:00:02.000Z",
          prUrl: PR_URL,
          prRepository: "closedloop-ai/closedloop-ai",
        }),
      ],
      { sessionId: "pr-link-absent" }
    );

    expect(session?.parseQuality).not.toHaveProperty("malformedPrLinkNumbers");
  });
});

function prLinkLine(prNumber: unknown, url: string) {
  return JSON.stringify({
    type: "pr-link",
    timestamp: "2026-07-09T12:00:02.000Z",
    prNumber,
    prUrl: url,
    prRepository: "closedloop-ai/closedloop-ai",
  });
}

function parsePrLink(prNumber: unknown) {
  return parseClaudeTranscript(
    [
      USER_LINE,
      JSON.stringify({
        type: "pr-link",
        timestamp: "2026-07-09T12:00:02.000Z",
        prNumber,
        prUrl: PR_URL,
        prRepository: "closedloop-ai/closedloop-ai",
      }),
    ],
    { sessionId: `pr-link-${String(prNumber)}` }
  );
}
