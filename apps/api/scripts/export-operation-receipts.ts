/**
 * ISS-12552: exports the receipts a collected session's
 * operations produced, and each written document's version before and after,
 * keyed by operation id, for a golden dossier's `server/receipts.json` and
 * `server/state.json`. Purely reads.
 *
 * Usage:
 *   tsx scripts/export-operation-receipts.ts --org <organization id> \
 *     --ids <file of harness call ids and clop_ operation ids, one per line> \
 *     --out <directory>
 *
 * Principal and API key ids are not exported: a dossier needs the operation,
 * not who held the key.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDb } from "@repo/database";

const OPERATION_ID_PREFIX = "clop_";

export type ReceiptRow = {
  id: string;
  source: string;
  operationKind: string;
  outcome: string;
  targetArtifactId: string | null;
  createdArtifactId: string | null;
  versionNumber: number | null;
  changedFields: string[];
  contentDigestBefore: string | null;
  contentDigestAfter: string | null;
  clientCallId: string | null;
  requestFingerprint: string | null;
  requestedAt: Date;
  committedAt: Date | null;
};

export type VersionRow = {
  documentId: string;
  version: number;
  content: string | null;
  createdAt: Date;
};

export type VersionState = {
  version: number;
  contentSha256: string | null;
  createdAt: string;
};

export type OperationReceiptExport = {
  receipts: Record<
    string,
    Omit<ReceiptRow, "id" | "requestedAt" | "committedAt"> & {
      requestedAt: string;
      committedAt: string | null;
    }
  >;
  state: Record<
    string,
    {
      documentId: string;
      before: VersionState | null;
      after: VersionState | null;
    }
  >;
};

/** Receipts keyed by operation id, and each versioned write's before and after. */
export function buildOperationReceiptExport(
  receipts: readonly ReceiptRow[],
  versions: readonly VersionRow[]
): OperationReceiptExport {
  const byDocument = new Map<string, Map<number, VersionRow>>();
  for (const version of versions) {
    const document = byDocument.get(version.documentId) ?? new Map();
    document.set(version.version, version);
    byDocument.set(version.documentId, document);
  }
  const ordered = [...receipts].sort(
    (left, right) =>
      left.requestedAt.getTime() - right.requestedAt.getTime() ||
      (left.id < right.id ? -1 : 1)
  );
  const output: OperationReceiptExport = { receipts: {}, state: {} };
  for (const { id, requestedAt, committedAt, ...receipt } of ordered) {
    const operationId = `${OPERATION_ID_PREFIX}${id}`;
    output.receipts[operationId] = {
      ...receipt,
      requestedAt: requestedAt.toISOString(),
      committedAt: committedAt?.toISOString() ?? null,
    };
    const documentId = receipt.createdArtifactId ?? receipt.targetArtifactId;
    const document = documentId ? byDocument.get(documentId) : undefined;
    if (documentId && document && receipt.versionNumber !== null) {
      output.state[operationId] = {
        documentId,
        before: versionState(document.get(receipt.versionNumber - 1)),
        after: versionState(document.get(receipt.versionNumber)),
      };
    }
  }
  return output;
}

function versionState(row: VersionRow | undefined): VersionState | null {
  return row
    ? {
        version: row.version,
        contentSha256:
          row.content === null
            ? null
            : createHash("sha256").update(row.content, "utf8").digest("hex"),
        createdAt: row.createdAt.toISOString(),
      }
    : null;
}

/** Splits a dossier's id list into harness call ids and receipt ids. */
export function parseIdList(text: string): {
  callIds: string[];
  receiptIds: string[];
} {
  const ids = [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ];
  return {
    callIds: ids.filter((id) => !id.startsWith(OPERATION_ID_PREFIX)),
    receiptIds: ids
      .filter((id) => id.startsWith(OPERATION_ID_PREFIX))
      .map((id) => id.slice(OPERATION_ID_PREFIX.length)),
  };
}

export async function exportOperationReceipts(
  organizationId: string,
  ids: { callIds: string[]; receiptIds: string[] }
): Promise<OperationReceiptExport> {
  const receipts = await withDb((db) =>
    db.artifactOperationReceipt.findMany({
      where: {
        organizationId,
        OR: [
          { clientCallId: { in: ids.callIds } },
          { id: { in: ids.receiptIds } },
        ],
      },
      select: {
        id: true,
        source: true,
        operationKind: true,
        outcome: true,
        targetArtifactId: true,
        createdArtifactId: true,
        versionNumber: true,
        changedFields: true,
        contentDigestBefore: true,
        contentDigestAfter: true,
        clientCallId: true,
        requestFingerprint: true,
        requestedAt: true,
        committedAt: true,
      },
    })
  );
  const documentIds = [
    ...new Set(
      receipts.flatMap((receipt) => {
        const documentId =
          receipt.createdArtifactId ?? receipt.targetArtifactId;
        return receipt.versionNumber !== null && documentId ? [documentId] : [];
      })
    ),
  ];
  const versions =
    documentIds.length === 0
      ? []
      : await withDb((db) =>
          db.documentVersion.findMany({
            where: {
              documentId: { in: documentIds },
              documentDetail: { artifact: { organizationId } },
            },
            select: {
              documentId: true,
              version: true,
              content: true,
              createdAt: true,
            },
          })
        );
  return buildOperationReceiptExport(receipts, versions);
}

async function main(): Promise<void> {
  const flag = (name: string): string => {
    const index = process.argv.indexOf(name);
    const value = index === -1 ? undefined : process.argv[index + 1];
    if (!value) {
      throw new Error(`${name} requires a value`);
    }
    return value;
  };
  const exported = await exportOperationReceipts(
    flag("--org"),
    parseIdList(readFileSync(flag("--ids"), "utf8"))
  );
  const out = flag("--out");
  writeFileSync(
    join(out, "receipts.json"),
    `${JSON.stringify(exported.receipts, null, 2)}\n`
  );
  writeFileSync(
    join(out, "state.json"),
    `${JSON.stringify(exported.state, null, 2)}\n`
  );
  process.stdout.write(
    `${Object.keys(exported.receipts).length} receipts, ${Object.keys(exported.state).length} versioned writes\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
