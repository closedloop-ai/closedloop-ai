/**
 * @file local-linked-artifacts.ts
 * @description ISS-5617: the desktop-LOCAL half of the session detail's
 * "Linked artifacts" pill row.
 *
 * The cloud session projection populates `linkedArtifacts` from the resolved
 * session→DOCUMENT `ArtifactLink` rows (`toLinkedArtifactProjection`). The
 * desktop-local projection populated nothing, so `SessionLinkedArtifactsRow` —
 * which returns `null` on an empty list — dropped the row entirely on every
 * local-mode session, and the same run showed linked artifacts on web and none
 * on the desktop.
 *
 * The local store already holds the same facts: `session_artifact_links` joined
 * to `artifacts(kind = 'closedloop_artifact')` is what the sync source folds
 * into `SyncedAgentSession.artifactRefs`, so the detail read has them in hand
 * and this module only has to reshape them. Nothing new is loaded, and nothing
 * is invented — the local projection emits ONLY what the local store can say.
 */
import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { parseTypedArtifactSlug } from "@repo/api/src/types/artifact-slug-parse";
import {
  ArtifactRefTargetKind,
  isHigherPrecedenceArtifactRole,
  roleFromMethod,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";

/**
 * Project a loaded local session's artifact refs into the `SessionLinkedArtifact`
 * shape the shared Properties pane renders.
 *
 * Deliberately narrow about what it claims:
 *
 *  - only `closedloop_artifact` refs — branch/PR/commit refs are owned by their
 *    own rows in that pane and would double-report here;
 *  - only refs whose slug prefix names a DOCUMENT type. This is the gate that
 *    keeps the two surfaces showing one set. The extractor's referenceable
 *    alphabet is wider than the document family: it emits `PRO-`/`WRK-` refs,
 *    and `slug_in_session_slug` emits the session's OWN `SES-` slug
 *    (`artifact-ref-extractor.ts`). The cloud drops every one of those —
 *    `toLinkedArtifactProjection` keeps only `ArtifactType.Document` targets and
 *    the ingest lane skips self-links — so passing them through here would grow
 *    a "Linked artifacts" row on the desktop for a session that has none on web,
 *    including the absurd case of a session listing itself;
 *  - `documentType` and the pill's slug come from {@link parseTypedArtifactSlug},
 *    the same prefix SSOT the web routes resolve through, so the desktop's
 *    absolute web-app href (`buildArtifactWebHref` → `getDocumentTypeRoute`)
 *    lands on the artifact the pill names;
 *  - `role` comes from the canonical {@link roleFromMethod} — the SAME derivation
 *    the cloud ingest lane persists into the link metadata the cloud projection
 *    reads back — so the two producers cannot describe one link differently;
 *  - `name` is NULL because the ref carries no title. That is the local store's
 *    honest "unknown", not a blank standing in for a value we could look up: the
 *    pill labels off `slug` first, so a null name costs the row nothing.
 *
 * Refs naming the same ENTITY are folded to one entry, with the
 * higher-precedence role winning — otherwise a slug reached by two extraction
 * methods would render a duplicate pill the web row never shows. The fold keys
 * on `identitySlug`, not the addressable slug, because `FEA-1952` and `ISS-1952`
 * are one artifact under the FEA-4137 rename and a session routinely picks up
 * both (a `fea-1952-*` branch name plus a prose `ISS-1952`).
 *
 * `id` is that identity slug rather than a UUID: the local store never resolved
 * these refs against the cloud, so no artifact UUID exists here to serve. It is
 * unique after the fold and stable across renders, which is what the consumer
 * (a React key) needs.
 *
 * KNOWN, ACCEPTED DIFFERENCE: the cloud projects RESOLVED links — a slug that
 * matched no artifact in the org never becomes one — while this projects the
 * refs the extractor observed, because a local read has no org directory to
 * resolve against. A transcript that mentions a slug which does not exist
 * therefore yields a pill here and none on web. That is the honest cost of an
 * offline surface: the alternative is showing nothing, which is the defect this
 * module exists to fix. Tracked on the ticket rather than papered over.
 */
export function projectLocalLinkedArtifacts(
  refs: readonly SyncedArtifactRef[] | undefined
): SessionLinkedArtifact[] {
  if (!refs?.length) {
    return [];
  }
  const bySlug = new Map<string, SessionLinkedArtifact>();
  for (const ref of refs) {
    if (ref.kind !== ArtifactRefTargetKind.ClosedloopArtifact) {
      continue;
    }
    const parsed = parseTypedArtifactSlug(ref.slug);
    // An untypable prefix (`PRO-`/`WRK-`/`SES-`) is not a document link on
    // either surface — see the gate in this module's doc comment.
    if (!parsed) {
      continue;
    }
    const role = roleFromMethod(ref.method, ref.isPrimary);
    const existing = bySlug.get(parsed.identitySlug);
    if (!existing) {
      bySlug.set(parsed.identitySlug, {
        id: parsed.identitySlug,
        slug: parsed.canonicalSlug,
        name: null,
        documentType: parsed.documentType,
        role,
      });
      continue;
    }
    if (
      existing.role !== null &&
      isHigherPrecedenceArtifactRole(role, existing.role)
    ) {
      existing.role = role;
    }
  }
  return [...bySlug.values()];
}
