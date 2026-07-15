/**
 * Unit tests for getPlanUploadDiagnostics — the pure log-enrichment helper
 * extracted from the upload-artifacts route. Exercises every logic branch:
 * plan present/absent, raw record present/absent, content match/mismatch/null,
 * and reusable-by-desktop true/false/null.
 */

import { shortContentHash } from "@repo/observability/content-hash";
import { describe, expect, it } from "vitest";
import { getPlanUploadDiagnostics } from "../diagnostics";

describe("getPlanUploadDiagnostics", () => {
  it("reports all-absent when the plan artifact is missing", () => {
    expect(getPlanUploadDiagnostics({})).toEqual({
      planArtifactPresent: false,
      planRawRecordPresent: false,
      planRawContentPresent: false,
      planRawContentMatchesArtifact: null,
      planRawReusableByDesktop: null,
      planContentLength: null,
      planRawContentLength: null,
      planContentHash: null,
      planRawContentHash: null,
    });
  });

  it("flags a plan present without a raw record as not reusable by desktop", () => {
    expect(getPlanUploadDiagnostics({ plan: { content: "abc" } })).toEqual({
      planArtifactPresent: true,
      planRawRecordPresent: false,
      planRawContentPresent: false,
      planRawContentMatchesArtifact: null,
      planRawReusableByDesktop: false,
      planContentLength: 3,
      planRawContentLength: null,
      planContentHash: shortContentHash("abc"),
      planRawContentHash: null,
    });
  });

  it("marks raw content reusable when it matches the artifact content", () => {
    expect(
      getPlanUploadDiagnostics({
        plan: { content: "abc", raw: { content: "abc" } },
      })
    ).toEqual({
      planArtifactPresent: true,
      planRawRecordPresent: true,
      planRawContentPresent: true,
      planRawContentMatchesArtifact: true,
      planRawReusableByDesktop: true,
      planContentLength: 3,
      planRawContentLength: 3,
      planContentHash: shortContentHash("abc"),
      planRawContentHash: shortContentHash("abc"),
    });
  });

  it("marks raw content not reusable when it differs from the artifact content", () => {
    expect(
      getPlanUploadDiagnostics({
        plan: { content: "abc", raw: { content: "wxyz" } },
      })
    ).toEqual({
      planArtifactPresent: true,
      planRawRecordPresent: true,
      planRawContentPresent: true,
      planRawContentMatchesArtifact: false,
      planRawReusableByDesktop: false,
      planContentLength: 3,
      planRawContentLength: 4,
      planContentHash: shortContentHash("abc"),
      planRawContentHash: shortContentHash("wxyz"),
    });
  });

  it("returns null comparisons when the artifact content is non-string", () => {
    expect(
      getPlanUploadDiagnostics({
        plan: { content: null, raw: { content: "abc" } },
      })
    ).toEqual({
      planArtifactPresent: true,
      planRawRecordPresent: true,
      planRawContentPresent: true,
      planRawContentMatchesArtifact: null,
      planRawReusableByDesktop: null,
      planContentLength: null,
      planRawContentLength: 3,
      planContentHash: null,
      planRawContentHash: shortContentHash("abc"),
    });
  });
});
