import { Priority } from "@repo/api/src/types/common";
import { unguardedGuardMessage } from "@repo/api/src/types/optimistic-write-guard";
import {
  MAX_PROJECT_TEAMS,
  PROJECT_TEAM_CAP_MESSAGE,
  ProjectStatus,
  repositoryOverridesValidator,
} from "@repo/api/src/types/project";
import { z } from "zod";
import {
  sanitizedTextFields,
  sanitizeJsonTree,
  sanitizeTextFields,
  sanitizeTextValue,
} from "@/lib/sanitize-text-fields";
import { transformIsoDateTime } from "@/lib/validators/date-time";
import { jsonValueValidator } from "@/lib/validators/json";

const priorityEnum = z.enum(Priority);
const projectStatusEnum = z.enum(ProjectStatus);

/**
 * Declared above the schemas rather than at the bottom of the file because both
 * validators evaluate it at module load. Exported so the enriched 400 leads with
 * the same sentence instead of Zod's default for a missing key
 * ("expected array, received undefined"), which tells the caller nothing.
 */
export const TEAM_REQUIRED_MESSAGE = "At least one team is required";

// Settings is a free-form JSON column, but the keys we know about must conform
// to their declared shapes. Unknown keys pass through untouched.
const projectSettingsBodyValidator = z
  .object({
    repositoryOverrides: repositoryOverridesValidator.optional(),
  })
  .catchall(jsonValueValidator);

const createProjectBodyValidator = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  // No `nullable()` here, matching `createDocumentValidator`: omitting the key
  // already creates the project with no priority, so an explicit `null` would
  // be a second spelling of the same request rather than a distinct one.
  priority: priorityEnum.optional(),
  status: projectStatusEnum.optional(),
  assigneeId: z.uuid().nullable().optional(),
  slug: z.string().nullable().optional(),
  targetDate: z.iso
    .datetime()
    .nullable()
    .optional()
    .transform(transformIsoDateTime),
  teamIds: z
    .array(z.uuid())
    .min(1, TEAM_REQUIRED_MESSAGE)
    .max(MAX_PROJECT_TEAMS, PROJECT_TEAM_CAP_MESSAGE),
});

const updateProjectBodyValidator = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  // ISS-11198: compared byte for byte with what the project renders, so NOT
  // bounded like the fields they guard.
  expectedName: z.string().optional(),
  expectedDescription: z.string().optional(),
  // ISS-9441: explicit `null` CLEARS the priority. `nullable()` before
  // `optional()` so an omitted key still means "leave it alone" — the two are
  // different requests, and since ISS-9833 the projects column stores both.
  priority: priorityEnum.nullable().optional(),
  status: projectStatusEnum.optional(),
  assigneeId: z.uuid().nullable().optional(),
  targetDate: z.iso
    .datetime()
    .nullable()
    .optional()
    .transform(transformIsoDateTime),
  // Omitting `teamIds` leaves the project's teams untouched; sending an empty
  // array would clear the last one and recreate the invisible-project state
  // ISS-6966 exists to close, so the empty array is rejected rather than
  // applied.
  teamIds: z
    .array(z.uuid())
    .min(1, TEAM_REQUIRED_MESSAGE)
    .max(MAX_PROJECT_TEAMS, PROJECT_TEAM_CAP_MESSAGE)
    .optional(),
  // ISS-11195: a NUL passes `jsonValueValidator` and fails the jsonb column.
  settings: sanitizeJsonTree(projectSettingsBodyValidator).optional(),
  codebaseSummary: z.string().nullable().optional(),
  lastIndexedAt: z.iso
    .datetime()
    .nullable()
    .optional()
    .transform(transformIsoDateTime),
  customFields: z
    .record(
      z.uuid(),
      sanitizeTextValue(
        z.union([
          z.string().max(10_000),
          z.number(),
          z.array(z.uuid()).max(100),
          z.null(),
        ])
      )
    )
    .optional(),
});

const refinedUpdateProjectValidator = updateProjectBodyValidator
  .refine(
    (body) => body.expectedName === undefined || body.name !== undefined,
    { message: unguardedGuardMessage("name"), path: ["expectedName"] }
  )
  .refine(
    (body) =>
      body.expectedDescription === undefined || body.description !== undefined,
    {
      message: unguardedGuardMessage("description"),
      path: ["expectedDescription"],
    }
  );

// ISS-11195: stored text is stripped of NUL before validation (a NUL passes
// `z.string()` and fails the `text` column as a 500). Exhaustive policies, so a
// text field added to a body fails `tsc` here until it is classified.
export const createProjectValidator = sanitizeTextFields(
  createProjectBodyValidator,
  sanitizedTextFields({
    name: true,
    description: true,
    priority: false,
    status: false,
    assigneeId: false,
    slug: true,
    targetDate: false,
    teamIds: false,
  } satisfies Record<keyof typeof createProjectBodyValidator.shape, boolean>)
);

// `expectedName` / `expectedDescription` are compared in memory against the
// locked row (`staleProjectField`), never bound into SQL, so they stay as sent.
export const updateProjectValidator = sanitizeTextFields(
  refinedUpdateProjectValidator,
  sanitizedTextFields({
    name: true,
    description: true,
    expectedName: false,
    expectedDescription: false,
    priority: false,
    status: false,
    assigneeId: false,
    targetDate: false,
    teamIds: false,
    // Nested: sanitized as a whole tree by `sanitizeJsonTree` above.
    settings: false,
    codebaseSummary: true,
    lastIndexedAt: false,
    customFields: false,
  } satisfies Record<keyof typeof updateProjectBodyValidator.shape, boolean>)
);
