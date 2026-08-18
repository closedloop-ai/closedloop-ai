/**
 * FEA-3267: the diff-stat LOC int4 bound on the desktop sync payload schema.
 * Split out of the (grandfathered, shrink-only)
 * `desktop-agent-sessions-handler.test.ts`; shares its fixtures. Pure schema
 * assertions — the handler is never invoked here.
 */
import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "../desktop-agent-sessions-schema";
import { validDesktopAgentSessionsPayload as validPayload } from "./desktop-agent-sessions-handler-fixtures";

describe("parseDesktopAgentSessionsPayload — diff-stat LOC int4 bound (FEA-3267)", () => {
  it("accepts session diff-stat LOC exactly at the int4 ceiling", () => {
    const result = parseDesktopAgentSessionsPayload({
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          linesAdded: PR_INT_MAX,
          gitDiffStats: {
            linesAdded: PR_INT_MAX,
            linesRemoved: 0,
            filesChanged: 0,
            source: "git",
          },
          branchDiffStats: {
            linesAdded: PR_INT_MAX,
            linesRemoved: 0,
            filesChanged: 0,
            source: "git",
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a flat LOC scalar past the int4 ceiling (would overflow the SessionDetail int4 sink)", () => {
    const result = parseDesktopAgentSessionsPayload({
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          linesAdded: PR_INT_MAX + 1,
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects gitDiffStats/branchDiffStats LOC past the int4 ceiling", () => {
    for (const field of ["gitDiffStats", "branchDiffStats"] as const) {
      const result = parseDesktopAgentSessionsPayload({
        ...validPayload,
        sessions: [
          {
            ...validPayload.sessions[0],
            [field]: {
              linesAdded: PR_INT_MAX + 1,
              linesRemoved: 0,
              filesChanged: 0,
              source: "git",
            },
          },
        ],
      });
      expect(result.ok).toBe(false);
    }
  });
});
