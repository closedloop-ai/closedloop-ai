// Split from `./onboarding.ts` so the client surfaces that import only its
// constants do not load `zod` for a parser they never run.
import { z } from "zod";
import {
  ChecklistItemId,
  type OnboardingChecklistItem,
  type OnboardingStatus,
} from "./onboarding.ts";

const checklistItemIdSchema = z.enum(ChecklistItemId);

const onboardingChecklistItemSchema = z.object({
  id: checklistItemIdSchema,
  label: z.string(),
  description: z.string(),
  completed: z.boolean(),
  href: z.string().optional(),
  external: z.boolean().optional(),
}) satisfies z.ZodType<OnboardingChecklistItem>;

const _checklistItemKeysCovered: Record<
  keyof OnboardingChecklistItem,
  z.ZodTypeAny
> = onboardingChecklistItemSchema.shape;

/**
 * Reader-side parser for {@link OnboardingStatus} (ISS-7828). The legacy
 * onboarding guard and page route on `wizardCompleted`, so a 2xx whose body is
 * not a status (`{}`, a proxy page) must become a query error they can render
 * as recoverable, never an `undefined` they each read differently.
 *
 * NOT `.strict()`, because this reads a server that may be a deploy ahead: an
 * unknown top-level key is a field this bundle does not read yet, and a
 * checklist row whose `id` this bundle does not know is dropped rather than
 * failing the whole status. A row with a KNOWN id and a malformed field still
 * fails — that is a broken body, not a newer one.
 */
export const onboardingStatusSchema = z.object({
  wizardCompleted: z.boolean(),
  checklistDismissed: z.boolean(),
  checklist: z
    .array(z.looseObject({ id: z.unknown() }))
    .transform((items) =>
      items.filter((item) => checklistItemIdSchema.safeParse(item.id).success)
    )
    .pipe(z.array(onboardingChecklistItemSchema)),
}) satisfies z.ZodType<OnboardingStatus>;

/**
 * Compile-time proof the status parser covers every field of
 * {@link OnboardingStatus}: a field added to the type without teaching the
 * schema fails `tsc` here instead of being stripped from every parsed status.
 */
const _onboardingStatusKeysCovered: Record<
  keyof OnboardingStatus,
  z.ZodTypeAny
> = onboardingStatusSchema.shape;
