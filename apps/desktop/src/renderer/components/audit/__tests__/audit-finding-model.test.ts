import type { Finding } from "@repo/crewd/passes/findings";
import { describe, expect, it } from "vitest";
import {
  AuditSeverity,
  deriveDisplayTitle,
  deriveLocation,
  deriveSeverity,
  groupFindingsBySeverity,
} from "../audit-finding-model";

function finding(overrides: Partial<Finding>): Finding {
  return {
    title: "a finding",
    description: "some evidence",
    ...overrides,
  };
}

describe("deriveSeverity", () => {
  it("reads a [SEVERITY] marker from the title", () => {
    expect(
      deriveSeverity(finding({ title: "[HIGH] README claims wrong script" }))
    ).toBe(AuditSeverity.High);
  });

  it("reads a severity: marker from the description", () => {
    expect(
      deriveSeverity(finding({ description: "severity: blocking\nbroken" }))
    ).toBe(AuditSeverity.Blocking);
  });

  it("maps critical→blocking and minor→low", () => {
    expect(deriveSeverity(finding({ title: "[critical] x" }))).toBe(
      AuditSeverity.Blocking
    );
    expect(deriveSeverity(finding({ title: "[minor] x" }))).toBe(
      AuditSeverity.Low
    );
  });

  it("falls back to unclassified without a marker", () => {
    expect(
      deriveSeverity(
        finding({ title: "no marker here", description: "critical prose word" })
      )
    ).toBe(AuditSeverity.Unclassified);
  });
});

describe("deriveLocation", () => {
  it("extracts the first path:line reference from the description", () => {
    expect(
      deriveLocation(
        finding({
          description: "README.md:12 says X but src/app.ts:40 does Y",
        })
      )
    ).toBe("README.md:12");
  });

  it("returns null when no path:line is cited", () => {
    expect(deriveLocation(finding({ description: "no location" }))).toBeNull();
  });
});

describe("deriveDisplayTitle", () => {
  it("strips a leading [SEVERITY] marker from the title", () => {
    expect(
      deriveDisplayTitle(
        finding({ title: "[HIGH] README claims wrong script" })
      )
    ).toBe("README claims wrong script");
  });

  it("keeps the title unchanged when there is no leading marker", () => {
    expect(deriveDisplayTitle(finding({ title: "plain title" }))).toBe(
      "plain title"
    );
  });

  it("does not strip a non-severity bracketed prefix", () => {
    expect(deriveDisplayTitle(finding({ title: "[README] mismatch" }))).toBe(
      "[README] mismatch"
    );
  });
});

describe("groupFindingsBySeverity", () => {
  it("groups findings into severity buckets in display order", () => {
    const findings: Finding[] = [
      finding({ title: "[low] a", signature: "sig-a" }),
      finding({ title: "[blocking] b", signature: "sig-b" }),
      finding({ title: "[low] c", signature: "sig-c" }),
      finding({ title: "unmarked d", signature: "sig-d" }),
    ];
    const groups = groupFindingsBySeverity(findings);

    expect(groups.map((g) => g.severity)).toEqual([
      AuditSeverity.Blocking,
      AuditSeverity.Low,
      AuditSeverity.Unclassified,
    ]);
    // Blocking bucket has one, Low has two (source order preserved).
    expect(groups[0].findings).toHaveLength(1);
    expect(groups[1].findings.map((v) => v.finding.signature)).toEqual([
      "sig-a",
      "sig-c",
    ]);
    expect(groups[2].findings).toHaveLength(1);
  });

  it("omits empty buckets and never drops a finding", () => {
    const findings: Finding[] = [
      finding({ title: "x" }),
      finding({ title: "y" }),
    ];
    const groups = groupFindingsBySeverity(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0].severity).toBe(AuditSeverity.Unclassified);
    expect(groups[0].findings).toHaveLength(2);
  });

  it("returns no groups for no findings", () => {
    expect(groupFindingsBySeverity([])).toEqual([]);
  });

  it("derives a stable id from the signature, else the title", () => {
    const [withSig] = groupFindingsBySeverity([
      finding({ title: "t", signature: "my-sig" }),
    ])[0].findings;
    expect(withSig.id).toBe("my-sig");

    const [withoutSig] = groupFindingsBySeverity([
      finding({ title: "Title Here" }),
    ])[0].findings;
    expect(withoutSig.id).toBe("title-here-0");
  });
});
