import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { documentService } from "@/app/documents/document-service";
import { loadSeedRoster } from "../core/base-seed-roster";
import type { VibeSeedContext } from "../stage";
import { SEED_ORG_DOCUMENTS } from "./content";

/**
 * ISS-12043: the organization's evergreen documents, project-less DOC
 * artifacts among the DOC artifacts the Documents index lists
 * (`documents-index-view.tsx` reads `type=DOC`). The base seed attaches every
 * document to a project, so that index was empty. Written through
 * `documentService.create`, the POST /documents path, and skipped by title
 * when already present.
 *
 * ISS-12135 (bugs 15, 23): written by engineering and product over the weeks
 * before the current work, not by one person at seed time. The create path
 * takes no time, so the dates are set afterwards.
 */
export async function seedOrgDocuments(
  context: VibeSeedContext
): Promise<void> {
  const { prisma, organizationId } = context;
  const existing = await prisma.artifact.findMany({
    where: {
      organizationId,
      type: ArtifactType.Document,
      subtype: DocumentType.Doc,
      projectId: null,
      name: { in: SEED_ORG_DOCUMENTS.map((document) => document.title) },
    },
    select: { name: true },
  });
  const present = new Set(existing.map((row) => row.name));
  const roster = await loadSeedRoster(context);
  // Runbooks by engineering, the release checklist by product, the decision
  // log by the signed-in person, in SEED_ORG_DOCUMENTS order.
  const authors = [
    roster.engineers[0],
    roster.engineers[1],
    roster.pms[0],
    roster.admin,
  ];
  let created = 0;
  for (const [index, document] of SEED_ORG_DOCUMENTS.entries()) {
    if (present.has(document.title)) {
      continue;
    }
    const author = authors[index] ?? roster.admin;
    const result = await documentService.create(organizationId, author, {
      type: DocumentType.Doc,
      title: document.title,
      content: document.content,
      assigneeId: author,
    });
    if (!result) {
      throw new Error(`creating document "${document.title}" failed`);
    }
    const createdAt = new Date(
      context.now.getTime() - (FIRST_WRITTEN_DAYS_AGO - index * 6) * DAY_MS
    );
    await prisma.artifact.update({
      where: { id: result.id },
      data: {
        createdAt,
        updatedAt: new Date(
          createdAt.getTime() + LAST_EDIT_AFTER_DAYS * DAY_MS
        ),
      },
      select: { id: true },
    });
    await prisma.documentVersion.updateMany({
      where: { documentId: result.id },
      data: { createdAt },
    });
    created += 1;
  }
  context.log(
    `org documents: ${created} created, ${present.size} already present`
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The oldest evergreen doc predates the oldest project work. */
const FIRST_WRITTEN_DAYS_AGO = 63;
const LAST_EDIT_AFTER_DAYS = 9;
