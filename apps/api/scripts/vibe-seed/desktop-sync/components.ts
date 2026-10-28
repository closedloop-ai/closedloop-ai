import { AGENT_COMPONENT_SYNC_SCHEMA_VERSION } from "@repo/api/src/types/agent-component-sync-schema-version";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { deterministicUuid } from "@repo/database/scripts/seed/helpers";
import { z } from "zod";
import { desktopComponentsSyncService } from "@/app/desktop/components/sync/service";
import { chunksOf } from "@/lib/chunks-of";
import { parseDesktopAgentComponentsPayload } from "@/lib/desktop-agent-components-parse";
import { parseJsonObject } from "@/lib/json-schema";
import { openSnapshot } from "../../perf-import-desktop-snapshot-reads";
import { type CorpusShiftTally, shiftCorpusIso } from "../core/corpus-shift";
import type { VibeSeedContext } from "../stage";
import {
  type DesktopSyncTarget,
  resolveDesktopSyncTarget,
} from "./sync-target";

/**
 * ISS-12017: replay the golden Desktop store's component inventory through
 * `desktopComponentsSyncService`, the service behind `POST
 * /desktop/components/sync`. Each `agent_components` row becomes one
 * `SyncedComponent`, carrying the retained `agent_component_versions` revisions
 * of its family as `variants` the way Desktop's `component-sync-source.ts`
 * packs them, so the cloud writes the `AgentComponent` and
 * `AgentComponentVersion` rows (and their definition-registry rows) itself.
 */

export const DESKTOP_COMPONENTS_STAGE = "desktop-components";

/**
 * Components per request. Desktop's chunker sizes requests by bytes under the
 * route's 256 KiB cap; the golden inventory's largest family fits many times
 * over at this count, and {@link syncComponentBatch} still refuses any batch
 * the route would.
 */
const COMPONENTS_PER_BATCH = 40;
const ROUTE_MAX_BYTES = 262_144;

const COMPONENT_SELECT = `
  SELECT
    id AS "id",
    component_kind AS "componentKind",
    external_id AS "externalId",
    component_key AS "componentKey",
    name AS "name",
    version AS "version",
    harness AS "harness",
    description AS "description",
    source_url AS "sourceUrl",
    install_path AS "installPath",
    pack_id AS "packId",
    scope AS "scope",
    project_path AS "projectPath",
    metadata AS "metadata",
    content AS "content",
    content_hash AS "contentHash",
    resolved_state AS "resolvedState",
    first_seen_at AS "firstSeenAt",
    last_seen_at AS "lastSeenAt",
    uninstalled_at AS "uninstalledAt"
  FROM agent_components
  ORDER BY last_seen_at ASC, id ASC
`;

const VERSION_SELECT = `
  SELECT
    component_kind AS "componentKind",
    component_key AS "componentKey",
    content_hash AS "contentHash",
    content AS "content",
    format AS "format",
    first_seen_at AS "firstSeenAt",
    last_seen_at AS "lastSeenAt"
  FROM agent_component_versions
  ORDER BY component_kind, component_key, last_seen_at DESC, content_hash
`;

const nullableText = z.string().nullable();

const storedComponentSchema = z.object({
  id: z.string(),
  componentKind: z.string(),
  externalId: z.string(),
  componentKey: nullableText,
  name: nullableText,
  version: nullableText,
  harness: nullableText,
  description: nullableText,
  sourceUrl: nullableText,
  installPath: nullableText,
  packId: nullableText,
  scope: nullableText,
  projectPath: nullableText,
  metadata: nullableText,
  content: nullableText,
  contentHash: nullableText,
  resolvedState: nullableText,
  firstSeenAt: nullableText,
  lastSeenAt: nullableText,
  uninstalledAt: nullableText,
});
type StoredComponent = z.infer<typeof storedComponentSchema>;

const storedVersionSchema = z.object({
  componentKind: z.string(),
  componentKey: z.string(),
  contentHash: z.string(),
  content: z.string(),
  format: nullableText,
  firstSeenAt: nullableText,
  lastSeenAt: nullableText,
});
type StoredVersion = z.infer<typeof storedVersionSchema>;

export async function syncGoldenComponents(
  context: VibeSeedContext
): Promise<void> {
  const target = await resolveDesktopSyncTarget(
    context,
    DESKTOP_COMPONENTS_STAGE
  );
  const { components, versions } = readStoredInventory(target.storePath);
  if (components.length === 0) {
    throw new Error("the Desktop store holds no agent_components to sync");
  }
  const tally: CorpusShiftTally = { clampedToNow: 0 };
  const versionsByFamily = groupVersionsByFamily(versions);
  const wire = components.map((component) =>
    toSyncedComponent(component, versionsByFamily, target, tally)
  );
  const batches = chunksOf(wire, COMPONENTS_PER_BATCH);
  for (const [index, batch] of batches.entries()) {
    await syncComponentBatch(target, batch, index);
  }
  target.log(
    `synced ${wire.length} component(s) with ${versions.length} retained revision(s) in ${batches.length} batch(es); ${tally.clampedToNow} timestamp(s) clamped to now`
  );
}

async function syncComponentBatch(
  target: DesktopSyncTarget,
  components: Record<string, unknown>[],
  index: number
): Promise<void> {
  const body = {
    schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
    batchId: deterministicUuid(
      `vibe-seed:${DESKTOP_COMPONENTS_STAGE}:${target.computeTargetId}:${index}`
    ),
    syncMode: AgentSessionSyncMode.Backfill,
    componentCount: components.length,
    components,
  };
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (bytes > ROUTE_MAX_BYTES) {
    throw new Error(
      `component batch ${index} is ${bytes} bytes, over the route's ${ROUTE_MAX_BYTES}-byte cap`
    );
  }
  const parsed = parseDesktopAgentComponentsPayload(body);
  if (!parsed.ok) {
    throw new Error(
      `component batch ${index} fails the route's payload schema: ${parsed.reason}`
    );
  }
  const result = await desktopComponentsSyncService.sync({
    clerkUserId: target.clerkUserId,
    computeTargetId: target.computeTargetId,
    organizationId: target.organizationId,
    payload: parsed.payload,
    userId: target.userId,
  });
  if (!result.ok) {
    throw new Error(
      `component sync refused batch ${index}: ${String(result.error)}`
    );
  }
}

function toSyncedComponent(
  component: StoredComponent,
  versionsByFamily: Map<string, StoredVersion[]>,
  target: DesktopSyncTarget,
  tally: CorpusShiftTally
): Record<string, unknown> {
  const shift = (value: string | null) =>
    shiftCorpusIso(value, target.shift, tally);
  const family =
    versionsByFamily.get(
      familyKey(component.componentKind, component.externalId)
    ) ?? [];
  const variants = family
    .filter((version) => version.contentHash !== component.contentHash)
    .map((version) => ({
      contentHash: version.contentHash,
      content: version.content,
      format: version.format,
      firstSeenAt: shift(version.firstSeenAt),
      lastSeenAt: shift(version.lastSeenAt),
    }));
  return {
    externalId: component.externalId,
    componentKind: component.componentKind,
    harness: component.harness,
    name: component.name,
    componentKey: component.componentKey,
    version: component.version,
    description: component.description,
    sourceUrl: component.sourceUrl,
    installPath: component.installPath,
    packId: component.packId,
    scope: component.scope,
    projectPath: component.projectPath,
    metadata: parseMetadata(component.metadata),
    content: component.content,
    contentHash: component.contentHash,
    resolvedState: component.resolvedState ?? "unresolved",
    firstSeenAt: shift(component.firstSeenAt),
    lastSeenAt: shift(component.lastSeenAt),
    uninstalledAt: shift(component.uninstalledAt),
    variants,
    variantsTruncated: false,
  };
}

function parseMetadata(text: string | null) {
  return text === null ? null : parseJsonObject(JSON.parse(text));
}

/**
 * Desktop keys a retained revision family by the definition's `externalId`,
 * which `agent_components` stores in both `external_id` and `component_key`.
 */
function familyKey(componentKind: string, componentKey: string): string {
  return `${componentKind}\u0000${componentKey}`;
}

function groupVersionsByFamily(
  versions: readonly StoredVersion[]
): Map<string, StoredVersion[]> {
  const grouped = new Map<string, StoredVersion[]>();
  for (const version of versions) {
    const key = familyKey(version.componentKind, version.componentKey);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(version);
    } else {
      grouped.set(key, [version]);
    }
  }
  return grouped;
}

function readStoredInventory(storePath: string): {
  components: StoredComponent[];
  versions: StoredVersion[];
} {
  const db = openSnapshot(storePath);
  try {
    return {
      components: z
        .array(storedComponentSchema)
        .parse(db.prepare(COMPONENT_SELECT).all()),
      versions: z
        .array(storedVersionSchema)
        .parse(db.prepare(VERSION_SELECT).all()),
    };
  } finally {
    db.close();
  }
}
