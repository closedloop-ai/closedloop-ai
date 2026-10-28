import { randomUUID } from "node:crypto";
import {
  CustomFieldEntityType,
  type CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { withDb } from "@repo/database";

/**
 * ISS-12552 flag-off parity: document custom fields a parity suite creates,
 * tracked so its cleanup can remove them (values first).
 */
export function createDocumentCustomFieldTracker() {
  const fieldIds = new Set<string>();
  return {
    async seed(
      organizationId: string,
      fieldType: CustomFieldType
    ): Promise<string> {
      const field = await withDb((db) =>
        db.customField.create({
          data: {
            organizationId,
            name: `ISS-12552 parity ${fieldType} ${randomUUID()}`,
            fieldType,
            entityTypes: [CustomFieldEntityType.Document],
          },
          select: { id: true },
        })
      );
      fieldIds.add(field.id);
      return field.id;
    },
    async cleanup(): Promise<void> {
      const ids = [...fieldIds];
      fieldIds.clear();
      await withDb(async (db) => {
        await db.customFieldValue.deleteMany({
          where: { customFieldId: { in: ids } },
        });
        await db.customField.deleteMany({ where: { id: { in: ids } } });
      });
    },
  };
}

/** What a document update left stored: its title, status and field values. */
export async function readStoredDocument(documentId: string) {
  return await withDb(async (db) => {
    const artifact = await db.artifact.findUniqueOrThrow({
      where: { id: documentId },
      select: { name: true, status: true },
    });
    return {
      title: artifact.name,
      status: artifact.status,
      values: await db.customFieldValue.count({
        where: { entityId: documentId },
      }),
    };
  });
}
