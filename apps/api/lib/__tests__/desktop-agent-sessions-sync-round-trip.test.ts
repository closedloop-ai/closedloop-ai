import {
  ArtifactRefMethod,
  ArtifactRefTargetKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "../desktop-agent-sessions-schema";
import { validDesktopAgentSessionsPayload as validPayload } from "./desktop-agent-sessions-handler-fixtures";

describe("sync round-trip — sanitize → JSON stringify → parse (FEA-1684 AC 48)", () => {
  const artifactRef = {
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    slug: "FEA-1684",
    isPrimary: true,
    method: ArtifactRefMethod.SlugInBranch,
  };

  const prRef = {
    repositoryFullName: "closedloop-ai/closedloop-ai",
    prNumber: 7,
    prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/7",
    relationType: SessionPrRelationType.Referenced,
  };

  const payloadWithRefs = {
    ...validPayload,
    sessions: [
      {
        ...validPayload.sessions[0],
        artifactRefs: [artifactRef],
        prRefs: [prRef],
      },
    ],
  };

  it("session with refs survives JSON stringify → parse → Zod validation (AC 48)", () => {
    const serialized = JSON.stringify(payloadWithRefs);
    const deserialized: unknown = JSON.parse(serialized);
    const result = parseDesktopAgentSessionsPayload(deserialized);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].artifactRefs).toEqual([artifactRef]);
      expect(result.payload.sessions[0].prRefs).toEqual([prRef]);
    }
  });
});
