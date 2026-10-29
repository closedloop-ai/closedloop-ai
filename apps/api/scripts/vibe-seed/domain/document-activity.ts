import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  type ArtifactStatus,
  DocumentStatus,
  type UpdateDocumentInput,
} from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { documentStatusMutationService } from "@/app/documents/document-status-mutation-service";
import {
  type ActivityActor,
  type CapturedArtifactFields,
  captureArtifactCreation,
  captureArtifactUpdate,
} from "@/lib/artifact-activity-capture";
import { findPlacedDocuments } from "../core/base-seed-placed";
import {
  type PlannedDocument,
  planBaseSeedContent,
} from "../core/base-seed-plan";
import { loadSeedRoster } from "../core/base-seed-roster";
import type { VibeSeedContext } from "../stage";

/**
 * ISS-12017, ISS-12135 (bug 23): activity feeds filled by real document edits.
 * Every planned document gets its creation receipt and then walks the rest of
 * its status history (`base-seed-plan.ts`) through the `PUT /documents/[id]`
 * write, `documentStatusMutationService.updateDocument`, with its activity
 * receipt `captureArtifactUpdate` on the same transaction, so
 * `artifact_activity_events` holds exactly what that route would have written.
 * Owners move their own work; approvals and change requests come from the
 * reviewer the plan names.
 *
 * Neither writer takes a time, so afterwards the receipts are spread across
 * the document's life and its planned `updatedAt` is put back. Progress is
 * read from the receipts already written, so a re-run finishes what an earlier
 * run left and edits nothing that is done.
 */

type DocumentEdit = Omit<UpdateDocumentInput, "id">;

/** Statuses a reviewer sets on someone else's document. */
const REVIEW_DECISIONS: ReadonlySet<string> = new Set([
  DocumentStatus.Approved,
  DocumentStatus.ChangesRequested,
]);

type PlannedRow = {
  readonly id: string;
  readonly document: PlannedDocument;
  /** Whether the creation receipt is already written. */
  readonly created: boolean;
  /** Status changes already recorded for it. */
  readonly recordedChanges: number;
};

export async function seedDocumentActivity(
  context: VibeSeedContext
): Promise<void> {
  const rows = await readProgress(context);
  let documents = 0;
  let edits = 0;
  for (const row of rows) {
    const remaining = remainingHistory(
      row.document.history,
      row.recordedChanges
    );
    if (row.created && remaining.length === 0) {
      continue;
    }
    edits += await replayHistory(context, row, remaining);
    documents += 1;
  }
  context.log(
    `document activity: ${documents} document(s) recorded, ${edits} status change(s), ${rows.length - documents} already complete`
  );
}

/**
 * The statuses still to walk, given how many changes an earlier run already
 * recorded: a run that stopped part way picks up where it left off.
 */
export function remainingHistory(
  history: readonly ArtifactStatus[],
  recordedChanges: number
): ArtifactStatus[] {
  return history.slice(1 + Math.max(0, recordedChanges));
}

async function readProgress(context: VibeSeedContext): Promise<PlannedRow[]> {
  const plan = planBaseSeedContent(await loadSeedRoster(context), context.now);
  const placed = await findPlacedDocuments(context, plan.documents);
  const events = await context.prisma.artifactActivityEvent.findMany({
    where: {
      organizationId: context.organizationId,
      artifactId: { in: [...placed.keys()] },
      action: {
        in: [
          ArtifactActivityAction.Creation,
          ArtifactActivityAction.StatusChange,
        ],
      },
    },
    select: { artifactId: true, action: true },
  });
  const created = new Set<string>();
  const changes = new Map<string, number>();
  for (const event of events) {
    if (event.action === ArtifactActivityAction.Creation) {
      created.add(event.artifactId);
    } else {
      changes.set(event.artifactId, (changes.get(event.artifactId) ?? 0) + 1);
    }
  }
  return [...placed].map(([id, document]) => ({
    id,
    document,
    created: created.has(id),
    recordedChanges: changes.get(id) ?? 0,
  }));
}

async function replayHistory(
  context: VibeSeedContext,
  { id, document, created }: PlannedRow,
  transitions: readonly ArtifactStatus[]
): Promise<number> {
  const { organizationId } = context;
  if (!created) {
    await withDb.tx((tx) =>
      captureArtifactCreation({
        tx,
        organizationId,
        artifactId: id,
        actor: actorFor(document.createdById),
        after: {
          status: document.history[0] ?? document.status,
          title: document.title,
        },
      })
    );
  }
  for (const status of transitions) {
    const actor = REVIEW_DECISIONS.has(status)
      ? document.reviewerId
      : document.assigneeId;
    await editDocument(context, id, { status }, actorFor(actor));
  }
  await backdate(context, id, document);
  return transitions.length;
}

function actorFor(userId: string): ActivityActor {
  return { userId, authMethod: "session" };
}

/**
 * Receipts in write order, spaced evenly from creation to the last change;
 * the edits stamped the row with the seed's clock, so its planned time is
 * restored.
 */
async function backdate(
  context: VibeSeedContext,
  id: string,
  document: PlannedDocument
): Promise<void> {
  const events = await context.prisma.artifactActivityEvent.findMany({
    where: { organizationId: context.organizationId, artifactId: id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  const start = document.createdAt.getTime();
  const span = document.updatedAt.getTime() - start;
  const steps = Math.max(1, events.length - 1);
  for (const [index, event] of events.entries()) {
    await context.prisma.artifactActivityEvent.update({
      where: { id: event.id },
      data: { createdAt: new Date(start + (span * index) / steps) },
      select: { id: true },
    });
  }
  await context.prisma.artifact.update({
    where: { id },
    data: { updatedAt: document.updatedAt },
    select: { id: true },
  });
}

async function editDocument(
  context: VibeSeedContext,
  documentId: string,
  edit: DocumentEdit,
  actor: ActivityActor
): Promise<void> {
  const result = await withDb.tx(async (tx) => {
    const written = await documentStatusMutationService.updateDocument(
      documentId,
      context.organizationId,
      edit
    );
    if (!written.ok) {
      return written;
    }
    const { document, previous } = written.value;
    await captureArtifactUpdate({
      tx,
      organizationId: context.organizationId,
      artifactId: document.id,
      actor,
      before: capturedFields(previous),
      after: capturedFields(document),
    });
    return written;
  });
  if (!result.ok) {
    throw new Error(
      `editing document ${documentId} with ${JSON.stringify(edit)} failed: ${JSON.stringify(result.error)}`
    );
  }
}

function capturedFields(document: {
  status: string;
  assigneeId: string | null;
  approverId: string | null;
  priority: string | null;
  title: string;
  dueDate?: Date | null;
  projectId: string | null;
}): CapturedArtifactFields {
  return {
    status: document.status,
    assigneeId: document.assigneeId,
    approverId: document.approverId,
    priority: document.priority,
    title: document.title,
    dueDate: document.dueDate ?? null,
    projectId: document.projectId,
  };
}
