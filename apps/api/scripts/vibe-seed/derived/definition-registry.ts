import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { VIBE_SEED_MACHINE_NAME } from "@repo/api/src/vibe-seed-corpus";
import { withDb } from "@repo/database";
import { z } from "zod";
import { registerDefinitionVersion } from "@/app/definition-registry/service";
import { ensurePerfComputeTarget } from "../../perf-import-desktop-snapshot";
import { openSnapshot } from "../../perf-import-desktop-snapshot-reads";
import { type CorpusShiftTally, shiftCorpusIso } from "../core/corpus-shift";
import type { VibeSeedContext } from "../stage";

/**
 * ISS-12017: register every exact definition the golden Desktop store holds
 * (`agent_component_versions.content`) through `registerDefinitionVersion`, the
 * F1 registry writer the Desktop component sync calls. That one producer writes
 * the `DefinitionVersion`, its local `SourceOccurrence` on the vibe compute
 * target, and the `DefinitionVersionEditor` lineage row for the local-trusted
 * user, exactly as a sync from that user's device would.
 */

const VERSION_SELECT = `
  SELECT
    v.component_kind AS "componentKind",
    v.component_key AS "componentKey",
    v.content AS "content",
    v.format AS "format",
    v.last_seen_at AS "lastSeenAt",
    (
      SELECT c.install_path FROM agent_components c
      WHERE c.component_kind = v.component_kind
        AND c.component_key = v.component_key
        AND c.install_path IS NOT NULL
      ORDER BY c.id
      LIMIT 1
    ) AS "installPath"
  FROM agent_component_versions v
  ORDER BY v.component_kind, v.component_key, v.content_hash
`;

const storedVersionSchema = z.object({
  componentKind: z.enum(AgentComponentKind),
  componentKey: z.string(),
  content: z.string().min(1),
  format: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  installPath: z.string().nullable(),
});

type StoredVersion = z.infer<typeof storedVersionSchema>;

export async function registerGoldenDefinitionVersions(
  context: VibeSeedContext
): Promise<void> {
  if (context.desktopStorePath === null) {
    throw new Error(
      "definition-registry needs the golden Desktop store; the run has none"
    );
  }
  const { versions, unreadable } = readStoredVersions(context.desktopStorePath);
  if (versions.length === 0) {
    throw new Error(
      `the Desktop store holds no readable agent_component_versions (${unreadable} unreadable)`
    );
  }
  const computeTargetId = await ensurePerfComputeTarget(
    { organizationId: context.organizationId, userId: context.userId },
    VIBE_SEED_MACHINE_NAME
  );
  const shift = {
    shiftMs: context.corpusShiftMs,
    nowMs: context.now.getTime(),
  };
  const tally: CorpusShiftTally = { clampedToNow: 0 };
  for (const version of versions) {
    const observedAt = shiftCorpusIso(version.lastSeenAt, shift, tally);
    await withDb.tx((tx) =>
      registerDefinitionVersion(tx, {
        organizationId: context.organizationId,
        componentKind: version.componentKind,
        content: version.content,
        format: version.format,
        computeTargetId,
        editorUserId: context.userId,
        installPath: version.installPath,
        ...(typeof observedAt === "string"
          ? { observedAt: new Date(observedAt) }
          : {}),
      })
    );
  }
  context.log(
    `registered ${versions.length} definition version(s); ${unreadable} store row(s) unreadable, ${tally.clampedToNow} observed-at clamped to now`
  );
}

function readStoredVersions(storePath: string): {
  versions: StoredVersion[];
  unreadable: number;
} {
  const db = openSnapshot(storePath);
  try {
    const rows = db.prepare(VERSION_SELECT).all();
    const versions: StoredVersion[] = [];
    for (const row of rows) {
      const parsed = storedVersionSchema.safeParse(row);
      if (parsed.success) {
        versions.push(parsed.data);
      }
    }
    return { versions, unreadable: rows.length - versions.length };
  } finally {
    db.close();
  }
}
