import {
  CustomFieldEntityType,
  CustomFieldType,
  LinkType,
  NumberFormat,
  ThreadSource,
  ThreadStatus,
} from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import { pickRequired } from "./allocations";
import type { CoreSeedResult } from "./core";
import {
  createSeedBatchTransactionRunner,
  createUpsertCounts,
  deterministicUuid,
  forEachSeedBatch,
  logUpsertSummary,
  seedLog,
  upsertRow,
} from "./helpers";
import type { SeedContext } from "./index";
import { resolveSeedRunPlan, SeedRngMode, type SeedRunPlan } from "./profiles";
import { createSeedRng, distributeLongTail } from "./rng";

/**
 * Shape of the data returned by seedCustomizationEntities so downstream seed
 * modules (T-6.2: settings and values) can reference stable field IDs without
 * re-querying.
 */
export type CustomizationSeedResult = {
  textFieldId: string;
  numberFieldId: string;
  enumFieldId: string;
  multiEnumFieldId: string;
  dateFieldId: string;
  peopleFieldId: string;
  enumOptionIds: string[];
  multiEnumOptionIds: string[];
};

/**
 * Builds a minimal ProseMirror document object containing a single paragraph
 * with the given text. Used for seeding comment body fields.
 */
function proseMirrorDoc(text: string): object {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function getScaledThreadState({
  source,
  organizationId,
  userId,
  baseDate,
  threadIndex,
}: {
  source: ThreadSource;
  organizationId: string;
  userId: string;
  baseDate: Date;
  threadIndex: number;
}): {
  status: ThreadStatus;
  resolvedById: string | null;
  resolvedAt: Date | null;
  roomId: string | null;
} {
  const isGithub = source === ThreadSource.GITHUB;
  const isLiveblocks = source === ThreadSource.LIVEBLOCKS;

  return {
    status: isGithub ? ThreadStatus.RESOLVED : ThreadStatus.OPEN,
    resolvedById: isGithub ? userId : null,
    resolvedAt: isGithub ? baseDate : null,
    roomId: isLiveblocks
      ? `seed-room-${organizationId.slice(0, 8)}-scaled-${threadIndex + 1}`
      : null,
  };
}

/**
 * Seeds CustomField definitions covering all 6 CustomFieldType values:
 * TEXT, NUMBER, ENUM, MULTI_ENUM, DATE, PEOPLE.
 *
 * For ENUM and MULTI_ENUM fields, 3 CustomFieldEnumOption rows are created each.
 *
 * All operations are idempotent — re-running the seed updates in place.
 *
 * @param prisma - Initialized PrismaClient connected to the target database.
 * @param context - Resolved organization and user identifiers.
 * @param coreResult - Core seed result providing project, workstream, and artifact IDs.
 * @returns IDs for all seeded fields and enum options for downstream use.
 */
export async function seedCustomizationEntities(
  prisma: TransactionClient,
  context: SeedContext,
  coreResult: CoreSeedResult,
  plan: SeedRunPlan = resolveSeedRunPlan()
): Promise<CustomizationSeedResult> {
  const { organizationId, userId } = context;
  const counts = createUpsertCounts();

  seedLog(
    "Seeding customization entities (CustomField, CustomFieldEnumOption)…"
  );

  // -------------------------------------------------------------------------
  // TEXT field
  // -------------------------------------------------------------------------

  const textFieldId = deterministicUuid(
    `custom-field:${organizationId}:text:notes`
  );

  await upsertRow({
    model: "CustomField",
    id: textFieldId,
    upsert: () =>
      prisma.customField.upsert({
        where: { id: textFieldId },
        create: {
          id: textFieldId,
          organizationId,
          name: "Notes",
          description: "Free-text notes for any entity.",
          fieldType: CustomFieldType.TEXT,
          createdById: userId,
          entityTypes: [
            CustomFieldEntityType.PROJECT,
            CustomFieldEntityType.DOCUMENT,
          ],
          isGlobalToOrg: true,
          showInTable: false,
          isSearchable: true,
          isSortable: false,
        },
        update: {
          name: "Notes",
          description: "Free-text notes for any entity.",
        },
      }),
    counts,
  });

  // -------------------------------------------------------------------------
  // NUMBER field
  // -------------------------------------------------------------------------

  const numberFieldId = deterministicUuid(
    `custom-field:${organizationId}:number:story-points`
  );

  await upsertRow({
    model: "CustomField",
    id: numberFieldId,
    upsert: () =>
      prisma.customField.upsert({
        where: { id: numberFieldId },
        create: {
          id: numberFieldId,
          organizationId,
          name: "Story Points",
          description: "Effort estimate in story points.",
          fieldType: CustomFieldType.NUMBER,
          createdById: userId,
          precision: 0,
          numberFormat: NumberFormat.NONE,
          entityTypes: [CustomFieldEntityType.DOCUMENT],
          isGlobalToOrg: true,
          showInTable: true,
          isSearchable: false,
          isSortable: true,
        },
        update: {
          name: "Story Points",
          description: "Effort estimate in story points.",
        },
      }),
    counts,
  });

  // -------------------------------------------------------------------------
  // ENUM field with 3 options
  // -------------------------------------------------------------------------

  const enumFieldId = deterministicUuid(
    `custom-field:${organizationId}:enum:team`
  );

  await upsertRow({
    model: "CustomField",
    id: enumFieldId,
    upsert: () =>
      prisma.customField.upsert({
        where: { id: enumFieldId },
        create: {
          id: enumFieldId,
          organizationId,
          name: "Team",
          description: "The team responsible for this item.",
          fieldType: CustomFieldType.ENUM,
          createdById: userId,
          entityTypes: [CustomFieldEntityType.PROJECT],
          isGlobalToOrg: true,
          showInTable: true,
          isSearchable: true,
          isSortable: true,
        },
        update: {
          name: "Team",
          description: "The team responsible for this item.",
        },
      }),
    counts,
  });

  // Enum options for "Team" field
  const enumOptionDefinitions = [
    { key: "frontend", name: "Frontend", color: "#3b82f6", sortOrder: 0 },
    { key: "backend", name: "Backend", color: "#10b981", sortOrder: 1 },
    { key: "platform", name: "Platform", color: "#8b5cf6", sortOrder: 2 },
  ];

  const enumOptionIds: string[] = [];

  for (const opt of enumOptionDefinitions) {
    const optId = deterministicUuid(
      `custom-field-enum-option:${enumFieldId}:${opt.key}`
    );
    enumOptionIds.push(optId);

    await upsertRow({
      model: "CustomFieldEnumOption",
      id: optId,
      upsert: () =>
        prisma.customFieldEnumOption.upsert({
          where: { id: optId },
          create: {
            id: optId,
            customFieldId: enumFieldId,
            name: opt.name,
            color: opt.color,
            enabled: true,
            sortOrder: opt.sortOrder,
          },
          update: {
            name: opt.name,
            color: opt.color,
            sortOrder: opt.sortOrder,
          },
        }),
      counts,
    });
  }

  // -------------------------------------------------------------------------
  // MULTI_ENUM field with 3 options
  // -------------------------------------------------------------------------

  const multiEnumFieldId = deterministicUuid(
    `custom-field:${organizationId}:multi-enum:labels`
  );

  await upsertRow({
    model: "CustomField",
    id: multiEnumFieldId,
    upsert: () =>
      prisma.customField.upsert({
        where: { id: multiEnumFieldId },
        create: {
          id: multiEnumFieldId,
          organizationId,
          name: "Labels",
          description: "One or more labels to categorize this item.",
          fieldType: CustomFieldType.MULTI_ENUM,
          createdById: userId,
          entityTypes: [
            CustomFieldEntityType.PROJECT,
            CustomFieldEntityType.DOCUMENT,
          ],
          isGlobalToOrg: true,
          showInTable: true,
          isSearchable: true,
          isSortable: false,
        },
        update: {
          name: "Labels",
          description: "One or more labels to categorize this item.",
        },
      }),
    counts,
  });

  // Enum options for "Labels" field
  const multiEnumOptionDefinitions = [
    {
      key: "breaking-change",
      name: "Breaking Change",
      color: "#ef4444",
      sortOrder: 0,
    },
    {
      key: "needs-design",
      name: "Needs Design",
      color: "#f59e0b",
      sortOrder: 1,
    },
    {
      key: "good-first-issue",
      name: "Good First Issue",
      color: "#22c55e",
      sortOrder: 2,
    },
  ];

  const multiEnumOptionIds: string[] = [];

  for (const opt of multiEnumOptionDefinitions) {
    const optId = deterministicUuid(
      `custom-field-enum-option:${multiEnumFieldId}:${opt.key}`
    );
    multiEnumOptionIds.push(optId);

    await upsertRow({
      model: "CustomFieldEnumOption",
      id: optId,
      upsert: () =>
        prisma.customFieldEnumOption.upsert({
          where: { id: optId },
          create: {
            id: optId,
            customFieldId: multiEnumFieldId,
            name: opt.name,
            color: opt.color,
            enabled: true,
            sortOrder: opt.sortOrder,
          },
          update: {
            name: opt.name,
            color: opt.color,
            sortOrder: opt.sortOrder,
          },
        }),
      counts,
    });
  }

  // -------------------------------------------------------------------------
  // DATE field
  // -------------------------------------------------------------------------

  const dateFieldId = deterministicUuid(
    `custom-field:${organizationId}:date:target-date`
  );

  await upsertRow({
    model: "CustomField",
    id: dateFieldId,
    upsert: () =>
      prisma.customField.upsert({
        where: { id: dateFieldId },
        create: {
          id: dateFieldId,
          organizationId,
          name: "Target Date",
          description: "The planned completion date for this item.",
          fieldType: CustomFieldType.DATE,
          createdById: userId,
          entityTypes: [CustomFieldEntityType.PROJECT],
          isGlobalToOrg: true,
          showInTable: true,
          isSearchable: false,
          isSortable: true,
        },
        update: {
          name: "Target Date",
          description: "The planned completion date for this item.",
        },
      }),
    counts,
  });

  // -------------------------------------------------------------------------
  // PEOPLE field
  // -------------------------------------------------------------------------

  const peopleFieldId = deterministicUuid(
    `custom-field:${organizationId}:people:reviewers`
  );

  await upsertRow({
    model: "CustomField",
    id: peopleFieldId,
    upsert: () =>
      prisma.customField.upsert({
        where: { id: peopleFieldId },
        create: {
          id: peopleFieldId,
          organizationId,
          name: "Reviewers",
          description: "People who should review this item.",
          fieldType: CustomFieldType.PEOPLE,
          createdById: userId,
          entityTypes: [CustomFieldEntityType.DOCUMENT],
          isGlobalToOrg: true,
          showInTable: false,
          isSearchable: false,
          isSortable: false,
        },
        update: {
          name: "Reviewers",
          description: "People who should review this item.",
        },
      }),
    counts,
  });

  logUpsertSummary(counts);

  const customizationResult: CustomizationSeedResult = {
    textFieldId,
    numberFieldId,
    enumFieldId,
    multiEnumFieldId,
    dateFieldId,
    peopleFieldId,
    enumOptionIds,
    multiEnumOptionIds,
  };

  await seedCustomFieldSettings(
    prisma,
    context,
    coreResult,
    customizationResult
  );
  await seedCustomFieldValues(prisma, context, coreResult, customizationResult);
  await seedComments(prisma, context, coreResult, plan);
  await seedArtifactLinks(prisma, context, coreResult);

  return customizationResult;
}

/**
 * Seeds CustomFieldSetting rows linking custom fields to specific entities
 * across PROJECT, WORKSTREAM, and DOCUMENT entity types.
 *
 * One setting row is created per (field, entityType, entityId) combination,
 * using the first seeded entity of each type. Fields are only linked to entity
 * types declared in their `entityTypes` array on the CustomField record.
 *
 * All operations are idempotent — re-running the seed updates in place.
 *
 * @param prisma - Initialized PrismaClient.
 * @param context - Resolved organization and user identifiers.
 * @param coreResult - Core seed result for project, workstream, and artifact IDs.
 * @param customizationResult - Field and enum option IDs from the field seed step.
 */
async function seedCustomFieldSettings(
  prisma: TransactionClient,
  context: SeedContext,
  coreResult: CoreSeedResult,
  customizationResult: CustomizationSeedResult
): Promise<void> {
  const { organizationId } = context;
  const counts = createUpsertCounts();

  seedLog(
    "Seeding CustomFieldSetting rows (one per field × entity type × entity)…"
  );

  const {
    textFieldId,
    numberFieldId,
    enumFieldId,
    multiEnumFieldId,
    dateFieldId,
    peopleFieldId,
  } = customizationResult;

  // One representative entity ID per entity type from the core seed.
  const projectEntityId = coreResult.projectIds[0];
  // artifactIds includes documents, branches and deployments. Index 0 is a DOCUMENT.
  const documentEntityId = coreResult.artifactIds[0];

  // Definitions: which fields apply to which entity types (mirrors entityTypes
  // declared on each CustomField in seedCustomizationEntities above).
  type SettingDefinition = {
    fieldId: string;
    entityType: CustomFieldEntityType;
    entityId: string;
    isImportant: boolean;
    isRequired: boolean;
    sortOrder: number;
  };

  const settingDefinitions: SettingDefinition[] = [
    {
      fieldId: textFieldId,
      entityType: CustomFieldEntityType.PROJECT,
      entityId: projectEntityId,
      isImportant: false,
      isRequired: false,
      sortOrder: 0,
    },
    {
      fieldId: textFieldId,
      entityType: CustomFieldEntityType.DOCUMENT,
      entityId: documentEntityId,
      isImportant: false,
      isRequired: false,
      sortOrder: 0,
    },
    {
      fieldId: numberFieldId,
      entityType: CustomFieldEntityType.DOCUMENT,
      entityId: documentEntityId,
      isImportant: true,
      isRequired: false,
      sortOrder: 1,
    },
    {
      fieldId: enumFieldId,
      entityType: CustomFieldEntityType.PROJECT,
      entityId: projectEntityId,
      isImportant: true,
      isRequired: true,
      sortOrder: 2,
    },
    {
      fieldId: multiEnumFieldId,
      entityType: CustomFieldEntityType.PROJECT,
      entityId: projectEntityId,
      isImportant: false,
      isRequired: false,
      sortOrder: 3,
    },
    {
      fieldId: multiEnumFieldId,
      entityType: CustomFieldEntityType.DOCUMENT,
      entityId: documentEntityId,
      isImportant: false,
      isRequired: false,
      sortOrder: 3,
    },
    {
      fieldId: dateFieldId,
      entityType: CustomFieldEntityType.PROJECT,
      entityId: projectEntityId,
      isImportant: true,
      isRequired: false,
      sortOrder: 4,
    },
    {
      fieldId: peopleFieldId,
      entityType: CustomFieldEntityType.DOCUMENT,
      entityId: documentEntityId,
      isImportant: false,
      isRequired: false,
      sortOrder: 5,
    },
  ];

  for (const def of settingDefinitions) {
    const settingId = deterministicUuid(
      `custom-field-setting:${def.fieldId}:${def.entityType}:${def.entityId}`
    );

    await upsertRow({
      model: "CustomFieldSetting",
      id: settingId,
      upsert: () =>
        prisma.customFieldSetting.upsert({
          where: { id: settingId },
          create: {
            id: settingId,
            customFieldId: def.fieldId,
            organizationId,
            entityType: def.entityType,
            entityId: def.entityId,
            isImportant: def.isImportant,
            isRequired: def.isRequired,
            sortOrder: def.sortOrder,
          },
          update: {
            isImportant: def.isImportant,
            isRequired: def.isRequired,
            sortOrder: def.sortOrder,
          },
        }),
      counts,
    });
  }

  logUpsertSummary(counts);
}

/**
 * Seeds CustomFieldValue rows with type-specific columns populated.
 *
 * One value row is created per (field, entityType, entityId) combination,
 * matching the settings created by seedCustomFieldSettings. Each row populates
 * exactly the column appropriate for the field's CustomFieldType:
 * - TEXT → textValue
 * - NUMBER → numberValue
 * - ENUM → enumValueId (references a CustomFieldEnumOption)
 * - MULTI_ENUM → multiEnumValueIds (references multiple options)
 * - DATE → dateValue
 * - PEOPLE → peopleValueIds (references a user)
 *
 * All operations are idempotent — re-running the seed updates in place.
 *
 * @param prisma - Initialized PrismaClient.
 * @param context - Resolved organization and user identifiers.
 * @param coreResult - Core seed result for project, workstream, and artifact IDs.
 * @param customizationResult - Field and enum option IDs from the field seed step.
 */
async function seedCustomFieldValues(
  prisma: TransactionClient,
  context: SeedContext,
  coreResult: CoreSeedResult,
  customizationResult: CustomizationSeedResult
): Promise<void> {
  const { organizationId, userId } = context;
  const counts = createUpsertCounts();

  seedLog(
    "Seeding CustomFieldValue rows (one per field × entity type × entity, type-specific columns populated)…"
  );

  const {
    textFieldId,
    numberFieldId,
    enumFieldId,
    multiEnumFieldId,
    dateFieldId,
    peopleFieldId,
    enumOptionIds,
    multiEnumOptionIds,
  } = customizationResult;

  const projectEntityId = coreResult.projectIds[0];
  const documentEntityId = coreResult.artifactIds[0];

  // A fixed target date for the DATE field values — stable across reruns.
  const targetDate = new Date("2026-12-31T00:00:00.000Z");

  type ValueDefinition = {
    fieldId: string;
    entityType: CustomFieldEntityType;
    entityId: string;
    textValue?: string;
    numberValue?: number;
    dateValue?: Date;
    enumValueId?: string;
    multiEnumValueIds?: string[];
    peopleValueIds?: string[];
    displayValue: string;
  };

  const valueDefinitions: ValueDefinition[] = [
    // TEXT (Notes) — PROJECT
    {
      fieldId: textFieldId,
      entityType: CustomFieldEntityType.PROJECT,
      entityId: projectEntityId,
      textValue: "Seed notes for this project.",
      displayValue: "Seed notes for this project.",
    },
    // TEXT (Notes) — DOCUMENT
    {
      fieldId: textFieldId,
      entityType: CustomFieldEntityType.DOCUMENT,
      entityId: documentEntityId,
      textValue: "Seed notes for this document.",
      displayValue: "Seed notes for this document.",
    },
    // NUMBER (Story Points) — DOCUMENT
    {
      fieldId: numberFieldId,
      entityType: CustomFieldEntityType.DOCUMENT,
      entityId: documentEntityId,
      numberValue: 5,
      displayValue: "5",
    },
    // ENUM (Team) — PROJECT; use enumOptionIds[0] = "Frontend"
    {
      fieldId: enumFieldId,
      entityType: CustomFieldEntityType.PROJECT,
      entityId: projectEntityId,
      enumValueId: enumOptionIds[0],
      displayValue: "Frontend",
    },
    // MULTI_ENUM (Labels) — PROJECT; use first two multiEnumOptionIds
    {
      fieldId: multiEnumFieldId,
      entityType: CustomFieldEntityType.PROJECT,
      entityId: projectEntityId,
      multiEnumValueIds: [multiEnumOptionIds[0], multiEnumOptionIds[1]],
      displayValue: "Breaking Change, Needs Design",
    },
    // MULTI_ENUM (Labels) — DOCUMENT; use first option
    {
      fieldId: multiEnumFieldId,
      entityType: CustomFieldEntityType.DOCUMENT,
      entityId: documentEntityId,
      multiEnumValueIds: [multiEnumOptionIds[0]],
      displayValue: "Breaking Change",
    },
    // DATE (Target Date) — PROJECT
    {
      fieldId: dateFieldId,
      entityType: CustomFieldEntityType.PROJECT,
      entityId: projectEntityId,
      dateValue: targetDate,
      displayValue: "2026-12-31",
    },
    // PEOPLE (Reviewers) — DOCUMENT
    {
      fieldId: peopleFieldId,
      entityType: CustomFieldEntityType.DOCUMENT,
      entityId: documentEntityId,
      peopleValueIds: [userId],
      displayValue: "Seed User",
    },
  ];

  for (const def of valueDefinitions) {
    const valueId = deterministicUuid(
      `custom-field-value:${def.fieldId}:${def.entityType}:${def.entityId}`
    );

    await upsertRow({
      model: "CustomFieldValue",
      id: valueId,
      upsert: () =>
        prisma.customFieldValue.upsert({
          where: { id: valueId },
          create: {
            id: valueId,
            customFieldId: def.fieldId,
            organizationId,
            entityType: def.entityType,
            entityId: def.entityId,
            textValue: def.textValue ?? null,
            numberValue: def.numberValue ?? null,
            dateValue: def.dateValue ?? null,
            enumValueId: def.enumValueId ?? null,
            multiEnumValueIds: def.multiEnumValueIds ?? [],
            peopleValueIds: def.peopleValueIds ?? [],
            displayValue: def.displayValue,
            updatedById: userId,
          },
          update: {
            textValue: def.textValue ?? null,
            numberValue: def.numberValue ?? null,
            dateValue: def.dateValue ?? null,
            enumValueId: def.enumValueId ?? null,
            multiEnumValueIds: def.multiEnumValueIds ?? [],
            peopleValueIds: def.peopleValueIds ?? [],
            displayValue: def.displayValue,
            updatedById: userId,
          },
        }),
      counts,
    });
  }

  logUpsertSummary(counts);
}

/**
 * Seeds CommentThread rows covering all three ThreadSource values (NATIVE,
 * LIVEBLOCKS, GITHUB) with associated Comment, CommentReaction, and
 * CommentAttachment children.
 *
 * Thread layout:
 * - NATIVE thread    → 2 comments, reaction on comment 1, attachment on comment 2
 * - LIVEBLOCKS thread → 2 comments, reaction on comment 1, attachment on comment 1
 * - GITHUB thread    → 1 comment, reaction on comment 1 (thread is RESOLVED)
 *
 * All operations are idempotent — re-running the seed updates in place.
 *
 * @param prisma - Initialized PrismaClient.
 * @param context - Resolved organization and user identifiers.
 * @param coreResult - Core seed result providing seeded artifact IDs.
 */
async function seedComments(
  prisma: TransactionClient,
  context: SeedContext,
  coreResult: CoreSeedResult,
  plan: SeedRunPlan
): Promise<void> {
  const { organizationId, userId } = context;
  const counts = createUpsertCounts();

  seedLog(
    "Seeding CommentThread, Comment, CommentReaction, and CommentAttachment rows…"
  );

  // Use the first three artifact IDs as anchor entities for each thread source.
  const nativeArtifactId = pickRequired(
    coreResult.artifactIds,
    0,
    "seedComments.artifactIds"
  );
  const liveblocksArtifactId = pickRequired(
    coreResult.artifactIds,
    1,
    "seedComments.artifactIds"
  );
  const githubArtifactId = pickRequired(
    coreResult.artifactIds,
    2,
    "seedComments.artifactIds"
  );

  // -------------------------------------------------------------------------
  // NATIVE thread
  // -------------------------------------------------------------------------

  const nativeThreadId = deterministicUuid(
    `comment-thread:${organizationId}:native`
  );

  await upsertRow({
    model: "CommentThread",
    id: nativeThreadId,
    upsert: () =>
      prisma.commentThread.upsert({
        where: { id: nativeThreadId },
        create: {
          id: nativeThreadId,
          organizationId,
          source: ThreadSource.NATIVE,
          artifactId: nativeArtifactId,
          status: ThreadStatus.OPEN,
          createdById: userId,
        },
        update: {
          status: ThreadStatus.OPEN,
        },
      }),
    counts,
  });

  const nativeComment1Id = deterministicUuid(`comment:${nativeThreadId}:1`);

  await upsertRow({
    model: "Comment",
    id: nativeComment1Id,
    upsert: () =>
      prisma.comment.upsert({
        where: { id: nativeComment1Id },
        create: {
          id: nativeComment1Id,
          threadId: nativeThreadId,
          authorId: userId,
          body: proseMirrorDoc("Initial feedback on this document."),
          plainText: "Initial feedback on this document.",
        },
        update: {
          plainText: "Initial feedback on this document.",
        },
      }),
    counts,
  });

  const nativeComment2Id = deterministicUuid(`comment:${nativeThreadId}:2`);

  await upsertRow({
    model: "Comment",
    id: nativeComment2Id,
    upsert: () =>
      prisma.comment.upsert({
        where: { id: nativeComment2Id },
        create: {
          id: nativeComment2Id,
          threadId: nativeThreadId,
          authorId: userId,
          body: proseMirrorDoc("Follow-up: looks good after review."),
          plainText: "Follow-up: looks good after review.",
          parentCommentId: nativeComment1Id,
        },
        update: {
          plainText: "Follow-up: looks good after review.",
        },
      }),
    counts,
  });

  // Reaction on comment 1 of the NATIVE thread.
  const nativeReactionId = deterministicUuid(
    `comment-reaction:${nativeComment1Id}:${userId}:thumbs-up`
  );

  await upsertRow({
    model: "CommentReaction",
    id: nativeReactionId,
    upsert: () =>
      prisma.commentReaction.upsert({
        where: {
          commentId_userId_emoji: {
            commentId: nativeComment1Id,
            userId,
            emoji: "👍",
          },
        },
        create: {
          id: nativeReactionId,
          commentId: nativeComment1Id,
          userId,
          emoji: "👍",
        },
        update: {},
      }),
    counts,
  });

  // Attachment on comment 2 of the NATIVE thread.
  const nativeAttachmentId = deterministicUuid(
    `comment-attachment:${nativeComment2Id}:spec-pdf`
  );

  await upsertRow({
    model: "CommentAttachment",
    id: nativeAttachmentId,
    upsert: () =>
      prisma.commentAttachment.upsert({
        where: { id: nativeAttachmentId },
        create: {
          id: nativeAttachmentId,
          commentId: nativeComment2Id,
          name: "seed-spec.pdf",
          size: 204_800,
          mimeType: "application/pdf",
          url: "https://example.com/seed-spec.pdf",
        },
        update: {
          name: "seed-spec.pdf",
        },
      }),
    counts,
  });

  // -------------------------------------------------------------------------
  // LIVEBLOCKS thread
  // -------------------------------------------------------------------------

  const liveblocksThreadId = deterministicUuid(
    `comment-thread:${organizationId}:liveblocks`
  );

  await upsertRow({
    model: "CommentThread",
    id: liveblocksThreadId,
    upsert: () =>
      prisma.commentThread.upsert({
        where: { id: liveblocksThreadId },
        create: {
          id: liveblocksThreadId,
          organizationId,
          source: ThreadSource.LIVEBLOCKS,
          artifactId: liveblocksArtifactId,
          roomId: `seed-room-${organizationId.slice(0, 8)}`,
          status: ThreadStatus.OPEN,
          createdById: userId,
        },
        update: {
          roomId: `seed-room-${organizationId.slice(0, 8)}`,
          status: ThreadStatus.OPEN,
        },
      }),
    counts,
  });

  const liveblocksComment1Id = deterministicUuid(
    `comment:${liveblocksThreadId}:1`
  );

  await upsertRow({
    model: "Comment",
    id: liveblocksComment1Id,
    upsert: () =>
      prisma.comment.upsert({
        where: { id: liveblocksComment1Id },
        create: {
          id: liveblocksComment1Id,
          threadId: liveblocksThreadId,
          authorId: userId,
          body: proseMirrorDoc("Liveblocks collaborative comment."),
          plainText: "Liveblocks collaborative comment.",
        },
        update: {
          plainText: "Liveblocks collaborative comment.",
        },
      }),
    counts,
  });

  const liveblocksComment2Id = deterministicUuid(
    `comment:${liveblocksThreadId}:2`
  );

  await upsertRow({
    model: "Comment",
    id: liveblocksComment2Id,
    upsert: () =>
      prisma.comment.upsert({
        where: { id: liveblocksComment2Id },
        create: {
          id: liveblocksComment2Id,
          threadId: liveblocksThreadId,
          authorId: userId,
          body: proseMirrorDoc("Resolved the concern mentioned above."),
          plainText: "Resolved the concern mentioned above.",
          parentCommentId: liveblocksComment1Id,
        },
        update: {
          plainText: "Resolved the concern mentioned above.",
        },
      }),
    counts,
  });

  // Reaction on comment 1 of the LIVEBLOCKS thread.
  const liveblocksReactionId = deterministicUuid(
    `comment-reaction:${liveblocksComment1Id}:${userId}:rocket`
  );

  await upsertRow({
    model: "CommentReaction",
    id: liveblocksReactionId,
    upsert: () =>
      prisma.commentReaction.upsert({
        where: {
          commentId_userId_emoji: {
            commentId: liveblocksComment1Id,
            userId,
            emoji: "🚀",
          },
        },
        create: {
          id: liveblocksReactionId,
          commentId: liveblocksComment1Id,
          userId,
          emoji: "🚀",
        },
        update: {},
      }),
    counts,
  });

  // Attachment on comment 1 of the LIVEBLOCKS thread.
  const liveblocksAttachmentId = deterministicUuid(
    `comment-attachment:${liveblocksComment1Id}:screenshot-png`
  );

  await upsertRow({
    model: "CommentAttachment",
    id: liveblocksAttachmentId,
    upsert: () =>
      prisma.commentAttachment.upsert({
        where: { id: liveblocksAttachmentId },
        create: {
          id: liveblocksAttachmentId,
          commentId: liveblocksComment1Id,
          name: "seed-screenshot.png",
          size: 51_200,
          mimeType: "image/png",
          url: "https://example.com/seed-screenshot.png",
        },
        update: {
          name: "seed-screenshot.png",
        },
      }),
    counts,
  });

  // -------------------------------------------------------------------------
  // GITHUB thread
  // -------------------------------------------------------------------------

  const githubThreadId = deterministicUuid(
    `comment-thread:${organizationId}:github`
  );

  await upsertRow({
    model: "CommentThread",
    id: githubThreadId,
    upsert: () =>
      prisma.commentThread.upsert({
        where: { id: githubThreadId },
        create: {
          id: githubThreadId,
          organizationId,
          source: ThreadSource.GITHUB,
          artifactId: githubArtifactId,
          status: ThreadStatus.RESOLVED,
          resolvedById: userId,
          resolvedAt: plan.clock.baseDate,
          createdById: userId,
        },
        update: {
          status: ThreadStatus.RESOLVED,
        },
      }),
    counts,
  });

  const githubComment1Id = deterministicUuid(`comment:${githubThreadId}:1`);

  await upsertRow({
    model: "Comment",
    id: githubComment1Id,
    upsert: () =>
      prisma.comment.upsert({
        where: { id: githubComment1Id },
        create: {
          id: githubComment1Id,
          threadId: githubThreadId,
          authorId: userId,
          body: proseMirrorDoc(
            "GitHub PR review comment — please address the naming convention."
          ),
          plainText:
            "GitHub PR review comment — please address the naming convention.",
        },
        update: {
          plainText:
            "GitHub PR review comment — please address the naming convention.",
        },
      }),
    counts,
  });

  // Reaction on comment 1 of the GITHUB thread.
  const githubReactionId = deterministicUuid(
    `comment-reaction:${githubComment1Id}:${userId}:eyes`
  );

  await upsertRow({
    model: "CommentReaction",
    id: githubReactionId,
    upsert: () =>
      prisma.commentReaction.upsert({
        where: {
          commentId_userId_emoji: {
            commentId: githubComment1Id,
            userId,
            emoji: "👀",
          },
        },
        create: {
          id: githubReactionId,
          commentId: githubComment1Id,
          userId,
          emoji: "👀",
        },
        update: {},
      }),
    counts,
  });

  const existingCommentCount = 5;
  const remainingCommentCount = Math.max(
    0,
    plan.targets.comments - existingCommentCount
  );
  const sourceCycle = [
    ThreadSource.NATIVE,
    ThreadSource.LIVEBLOCKS,
    ThreadSource.GITHUB,
  ] as const;
  const commentThreadSizes =
    plan.rngMode === SeedRngMode.Perf && remainingCommentCount > 0
      ? distributeLongTail(
          remainingCommentCount,
          Math.min(
            coreResult.artifactIds.length,
            Math.max(1, Math.ceil(Math.sqrt(remainingCommentCount)))
          )
        )
      : Array.from({ length: remainingCommentCount }, () => 1);
  const commentRng =
    plan.rngMode === SeedRngMode.Perf
      ? createSeedRng(`${plan.rngSeed}:comments`)
      : null;
  let commentIndex = existingCommentCount + 1;

  await forEachSeedBatch({
    items: commentThreadSizes,
    batchSize: plan.transaction.batchSize,
    label: "comment threads",
    runBatch: createSeedBatchTransactionRunner(prisma, plan.transaction),
    run: async (commentsInThread, threadIndex, batchClient) => {
      if (commentsInThread === 0) {
        return;
      }
      const batchPrisma = batchClient ?? prisma;
      const source = commentRng
        ? commentRng.pick(sourceCycle)
        : sourceCycle[commentIndex % sourceCycle.length];
      const threadId = deterministicUuid(
        `comment-thread:${organizationId}:scaled-${threadIndex + 1}`
      );
      const threadState = getScaledThreadState({
        source,
        organizationId,
        userId,
        baseDate: plan.clock.baseDate,
        threadIndex,
      });

      await upsertRow({
        model: "CommentThread",
        id: threadId,
        upsert: () =>
          batchPrisma.commentThread.upsert({
            where: { id: threadId },
            create: {
              id: threadId,
              organizationId,
              source,
              artifactId: pickRequired(
                coreResult.artifactIds,
                commentRng
                  ? commentRng.integer(0, coreResult.artifactIds.length - 1)
                  : commentIndex,
                "seedComments.scaled.artifactIds"
              ),
              status: threadState.status,
              resolvedById: threadState.resolvedById,
              resolvedAt: threadState.resolvedAt,
              roomId: threadState.roomId,
              createdById: userId,
            },
            update: {
              status: threadState.status,
              roomId: threadState.roomId,
            },
          }),
        counts,
      });

      for (
        let threadCommentIndex = 1;
        threadCommentIndex <= commentsInThread;
        threadCommentIndex++
      ) {
        const commentId = deterministicUuid(
          `comment:${threadId}:${threadCommentIndex}`
        );
        const parentCommentId =
          threadCommentIndex === 1
            ? null
            : deterministicUuid(
                `comment:${threadId}:${threadCommentIndex - 1}`
              );
        await upsertRow({
          model: "Comment",
          id: commentId,
          upsert: () =>
            batchPrisma.comment.upsert({
              where: { id: commentId },
              create: {
                id: commentId,
                threadId,
                authorId: userId,
                body: proseMirrorDoc(`Scaled seed comment ${commentIndex}.`),
                plainText: `Scaled seed comment ${commentIndex}.`,
                parentCommentId,
              },
              update: {
                plainText: `Scaled seed comment ${commentIndex}.`,
              },
            }),
          counts,
        });
        commentIndex++;
      }
    },
  });

  logUpsertSummary(counts);
}

/**
 * Seeds ArtifactLink rows covering all three LinkType values:
 * - PRODUCES:   artifact[0] → artifact[1]  (e.g. PRD produces an implementation plan)
 * - BLOCKS:     artifact[2] → artifact[3]  (one document blocks another)
 * - RELATES_TO: artifact[4] → artifact[5]  (two documents are related)
 *
 * All operations are idempotent — re-running the seed updates in place.
 *
 * @param prisma - Initialized PrismaClient.
 * @param context - Resolved organization and user identifiers.
 * @param coreResult - Core seed result providing seeded artifact IDs.
 */
async function seedArtifactLinks(
  prisma: TransactionClient,
  context: SeedContext,
  coreResult: CoreSeedResult
): Promise<void> {
  const { organizationId } = context;
  const counts = createUpsertCounts();

  seedLog(
    "Seeding ArtifactLink rows (one per LinkType: PRODUCES, BLOCKS, RELATES_TO)…"
  );

  type LinkDefinition = {
    linkType: LinkType;
    sourceIndex: number;
    targetIndex: number;
  };

  const linkDefinitions: LinkDefinition[] = [
    { linkType: LinkType.PRODUCES, sourceIndex: 0, targetIndex: 1 },
    { linkType: LinkType.BLOCKS, sourceIndex: 2, targetIndex: 3 },
    { linkType: LinkType.RELATES_TO, sourceIndex: 4, targetIndex: 5 },
  ];

  for (const def of linkDefinitions) {
    const sourceId = pickRequired(
      coreResult.artifactIds,
      def.sourceIndex,
      "seedArtifactLinks.sourceArtifacts"
    );
    const targetId = pickRequired(
      coreResult.artifactIds,
      def.targetIndex,
      "seedArtifactLinks.targetArtifacts"
    );
    const linkId = deterministicUuid(
      `artifact-link:${organizationId}:${sourceId}:${targetId}:${def.linkType}`
    );

    await upsertRow({
      model: "ArtifactLink",
      id: linkId,
      upsert: () =>
        prisma.artifactLink.upsert({
          where: {
            sourceId_targetId_linkType: {
              sourceId,
              targetId,
              linkType: def.linkType,
            },
          },
          create: {
            id: linkId,
            organizationId,
            sourceId,
            targetId,
            linkType: def.linkType,
          },
          update: {},
        }),
      counts,
    });
  }

  logUpsertSummary(counts);
}
