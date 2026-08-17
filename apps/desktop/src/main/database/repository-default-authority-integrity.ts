/**
 * @file repository-default-authority-integrity.ts
 * @description ISS-5838 schema-aware store-integrity check for persisted
 * repository-default authority rows. Rows are scanned in bounded pages inside
 * one read snapshot and parsed by the production row normalizer; telemetry
 * receives only a table identifier and the presence of malformed rows.
 */
import { z } from "zod";
import type { StoreIntegrityIssue } from "../telemetry/telemetry-protocol.js";
import {
  defineStoreIntegrityOptionalCheck,
  type StoreIntegrityOptionalCheck,
} from "./database-integrity/store-integrity-probe.js";
import type { DesktopPrisma, DesktopPrismaReader } from "./prisma-client.js";
import { authorityFromStoredRow } from "./repository-default-authority-store.js";

/** Maximum rows retained by the integrity scan at one time. */
export const REPOSITORY_DEFAULT_AUTHORITY_INTEGRITY_PAGE_SIZE = 100;

/** Clone-safe aggregate returned across the DB-host boundary. */
export type RepositoryDefaultAuthorityIntegrityResult = {
  malformedRows: number;
};

/** Optional DB-host read surface consumed by the regularly wired probe. */
export type RepositoryDefaultAuthorityIntegrityReader = {
  runRepositoryDefaultAuthorityIntegrityCheck?(): Promise<RepositoryDefaultAuthorityIntegrityResult>;
};

/** Runtime boundary for a version-skewed DB-host response. */
export const REPOSITORY_DEFAULT_AUTHORITY_INTEGRITY_SCHEMA = z.object({
  malformedRows: z.number().int().nonnegative().safe(),
});

/**
 * Scan persisted authorities in stable primary-key pages, counting rows the
 * production row normalizer rejects without retaining row content or identity.
 */
export function runRepositoryDefaultAuthorityIntegrityCheck(
  prisma: DesktopPrisma
): Promise<RepositoryDefaultAuthorityIntegrityResult> {
  return prisma.read((reader) =>
    reader.$transaction(scanRepositoryDefaultAuthorityRows)
  );
}

/** Convert a positive malformed-row count into one content-free table issue. */
export function classifyRepositoryDefaultAuthorityIntegrity(
  result: RepositoryDefaultAuthorityIntegrityResult,
  issues: StoreIntegrityIssue[]
): void {
  if (result.malformedRows > 0) {
    issues.push({
      check: "repository_default_authority",
      category: "malformed_repository_default_authority",
      object: "repository_default_authorities",
      objectType: "table",
    });
  }
}

/** Compose the clone-safe read, validation, and classifier for probe wiring. */
export function repositoryDefaultAuthorityIntegrityCheck(
  reader: RepositoryDefaultAuthorityIntegrityReader
): StoreIntegrityOptionalCheck {
  return defineStoreIntegrityOptionalCheck({
    name: "repository_default_authority",
    label: "repository default authority integrity check",
    read: reader.runRepositoryDefaultAuthorityIntegrityCheck
      ? () =>
          Promise.resolve(
            reader.runRepositoryDefaultAuthorityIntegrityCheck?.()
          )
      : undefined,
    schema: REPOSITORY_DEFAULT_AUTHORITY_INTEGRITY_SCHEMA,
    classify: classifyRepositoryDefaultAuthorityIntegrity,
  });
}

async function scanRepositoryDefaultAuthorityRows(
  transaction: DesktopPrismaReader
): Promise<RepositoryDefaultAuthorityIntegrityResult> {
  let malformedRows = 0;
  let cursor:
    | {
        identityKey: string;
        provider: string;
        providerRepositoryId: string;
      }
    | undefined;

  while (true) {
    const rows = await transaction.repositoryDefaultAuthority.findMany({
      orderBy: [
        { identityKey: "asc" },
        { provider: "asc" },
        { providerRepositoryId: "asc" },
      ],
      take: REPOSITORY_DEFAULT_AUTHORITY_INTEGRITY_PAGE_SIZE,
      ...(cursor
        ? {
            cursor: { identityKey_provider_providerRepositoryId: cursor },
            skip: 1,
          }
        : {}),
    });
    for (const row of rows) {
      if (authorityFromStoredRow(row) === undefined) {
        malformedRows += 1;
      }
    }
    const last = rows.at(-1);
    if (
      last === undefined ||
      rows.length < REPOSITORY_DEFAULT_AUTHORITY_INTEGRITY_PAGE_SIZE
    ) {
      break;
    }
    cursor = {
      identityKey: last.identityKey,
      provider: last.provider,
      providerRepositoryId: last.providerRepositoryId,
    };
  }

  return { malformedRows };
}
