/**
 * Integrity tests for the generated RDS CA bundle module
 * (`scripts/rds-ca-bundle.ts`, produced by `scripts/generate-rds-ca-bundle.ts`).
 *
 * These run offline — no network. They assert that the embedded bundle still
 * matches its pinned SHA-256 (so a hand-edit or corrupted regeneration is
 * caught) and is genuinely the Amazon RDS CA set. The networked drift check
 * against AWS lives in the generator's `--check` mode, not here.
 */

import { createHash, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AWS_RDS_CA_BUNDLE,
  AWS_RDS_CA_BUNDLE_CERT_COUNT,
  AWS_RDS_CA_BUNDLE_SHA256,
  AWS_RDS_CA_BUNDLE_SOURCE_URL,
} from "../../../rds-ca-bundle";

const CERT_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const RDS_SUBJECT_PATTERN = /Amazon RDS/i;

function parseCerts(pem: string): string[] {
  return pem.match(CERT_PATTERN) ?? [];
}

describe("rds-ca-bundle — generated module integrity", () => {
  it("embedded bundle matches its pinned SHA-256", () => {
    // Mirrors the generator: checksum is over the trimmed PEM. Catches any
    // hand-edit of the AUTO-GENERATED module without a regenerate.
    const digest = createHash("sha256")
      .update(AWS_RDS_CA_BUNDLE.trim(), "utf8")
      .digest("hex");
    expect(digest).toBe(AWS_RDS_CA_BUNDLE_SHA256);
  });

  it("pins the canonical AWS global truststore as its source", () => {
    expect(AWS_RDS_CA_BUNDLE_SOURCE_URL).toBe(
      "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem"
    );
  });

  it("contains only parseable Amazon RDS certificates", () => {
    const certs = parseCerts(AWS_RDS_CA_BUNDLE);
    expect(certs.length).toBeGreaterThanOrEqual(50);
    expect(certs.length).toBe(AWS_RDS_CA_BUNDLE_CERT_COUNT);
    for (const cert of certs) {
      // Constructor throws on a malformed certificate.
      const parsed = new X509Certificate(cert);
      expect(parsed.subject).toMatch(RDS_SUBJECT_PATTERN);
    }
  });
});
