import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  PR_INT_MAX,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import { DesktopAgentSessionsPayloadDiagnosticCode } from "../desktop-agent-sessions-pr-number-preprocess";
import { parseDesktopAgentSessionsPayload } from "../desktop-agent-sessions-schema";
import { validDesktopAgentSessionsPayload as validPayload } from "./desktop-agent-sessions-handler-fixtures";

describe("parseDesktopAgentSessionsPayload — PR number bounds (ISS-8338)", () => {
  it("drops an oversized pull_request artifactRef and preserves valid siblings", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [
            closedloopArtifactRef(),
            pullRequestArtifactRef(PR_INT_MAX + 1),
            pullRequestArtifactRef(PR_INT_MAX),
          ],
        },
      ],
    };

    const result = parseDesktopAgentSessionsPayload(payload);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].artifactRefs).toEqual([
        closedloopArtifactRef(),
        pullRequestArtifactRef(PR_INT_MAX),
      ]);
    }
  });

  it("treats all-dropped artifactRefs as no-op instead of an explicit clear", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [pullRequestArtifactRef(PR_INT_MAX + 1)],
        },
      ],
    };

    const result = parseDesktopAgentSessionsPayload(payload);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].artifactRefs).toBeUndefined();
    }
  });

  it("keeps mixed unknown-kind and oversized artifactRefs as no-op", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [
            { kind: "some_future_kind", repositoryFullName: "acme/web" },
            pullRequestArtifactRef(PR_INT_MAX + 1),
          ],
        },
      ],
    };

    const result = parseDesktopAgentSessionsPayload(payload);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].artifactRefs).toBeUndefined();
    }
  });

  it("does not let an oversized artifactRef mask other malformed fields", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [
            { ...pullRequestArtifactRef(PR_INT_MAX + 1), method: "" },
          ],
        },
      ],
    };

    expect(parseDesktopAgentSessionsPayload(payload).ok).toBe(false);
  });

  it("drops an oversized session prRef and preserves valid siblings", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          prRefs: [sessionPrRef(PR_INT_MAX + 1), sessionPrRef(PR_INT_MAX)],
        },
      ],
    };

    const result = parseDesktopAgentSessionsPayload(payload);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].prRefs).toEqual([
        sessionPrRef(PR_INT_MAX),
      ]);
    }
  });

  it("treats all-dropped prRefs as no-op instead of an explicit clear", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          prRefs: [sessionPrRef(PR_INT_MAX + 1)],
        },
      ],
    };

    const result = parseDesktopAgentSessionsPayload(payload);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].prRefs).toBeUndefined();
    }
  });

  it("does not let an oversized prRef mask other malformed fields", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          prRefs: [
            { ...sessionPrRef(PR_INT_MAX + 1), relationType: "AUTHORED" },
          ],
        },
      ],
    };

    expect(parseDesktopAgentSessionsPayload(payload).ok).toBe(false);
  });

  it("reports bounded diagnostics for dropped oversized refs", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [
            pullRequestArtifactRef(PR_INT_MAX + 1),
            pullRequestArtifactRef(PR_INT_MAX),
          ],
          prRefs: [sessionPrRef(PR_INT_MAX + 2)],
        },
        {
          ...validPayload.sessions[0],
          externalSessionId: "sess-2",
          artifactRefs: [pullRequestArtifactRef(PR_INT_MAX + 3)],
        },
      ],
      sessionCount: 2,
    };

    const result = parseDesktopAgentSessionsPayload(payload);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostics).toEqual([
        {
          artifactRefCount: 2,
          code: DesktopAgentSessionsPayloadDiagnosticCode.OversizedPullRequestRefDropped,
          maxPrNumber: PR_INT_MAX + 3,
          prRefCount: 1,
          samples: [
            {
              field: "artifactRefs",
              prNumber: PR_INT_MAX + 1,
              repositoryFullName: "closedloop-ai/closedloop-ai",
              sessionExternalId: "sess-1",
            },
            {
              field: "prRefs",
              prNumber: PR_INT_MAX + 2,
              repositoryFullName: "closedloop-ai/closedloop-ai",
              sessionExternalId: "sess-1",
            },
            {
              field: "artifactRefs",
              prNumber: PR_INT_MAX + 3,
              repositoryFullName: "closedloop-ai/closedloop-ai",
              sessionExternalId: "sess-2",
            },
          ],
          sessionCount: 2,
        },
      ]);
    }
  });
});

function closedloopArtifactRef() {
  return {
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    slug: "ISS-8338",
    isPrimary: true,
    method: ArtifactRefMethod.McpToolCall,
  };
}

function pullRequestArtifactRef(prNumber: number) {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: "closedloop-ai/closedloop-ai",
    prNumber,
    method: ArtifactRefMethod.HarnessPrLink,
    relation: ArtifactRefRelation.Referenced,
  };
}

function sessionPrRef(prNumber: number) {
  return {
    repositoryFullName: "closedloop-ai/closedloop-ai",
    prNumber,
    prUrl: `https://github.com/closedloop-ai/closedloop-ai/pull/${prNumber}`,
    relationType: SessionPrRelationType.Referenced,
  };
}
