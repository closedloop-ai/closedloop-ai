import {
  type TableGroupingLevel,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { z } from "zod";

/**
 * How a `TableGroupingState` crosses persistence, stated once.
 *
 * Sessions declared this to serialize its own view state (ISS-8335) and
 * Branches needs the identical shape for its saved views (ISS-9676), which is
 * two spellings of one design-system contract — the drift a shared module
 * exists to stop. A grouping level gaining a field has to be taught to the
 * boundary once, here, rather than in each surface's serializer.
 *
 * `.loose()` at both levels, deliberately: web and desktop ship on different
 * cadences, so restoring a view on the older build must carry an unknown
 * grouping key across its read→write cycle instead of stripping it.
 */
export const TABLE_GROUPING_LEVEL_SCHEMA = z
  .object({
    fieldId: z.string().nullable(),
    order: z.enum(TableGroupOrder),
    showEmptyGroups: z.boolean(),
  } satisfies Record<keyof TableGroupingLevel, z.ZodTypeAny>)
  .loose();

export const TABLE_GROUPING_SCHEMA = z
  .object({
    primary: TABLE_GROUPING_LEVEL_SCHEMA,
    secondary: TABLE_GROUPING_LEVEL_SCHEMA,
  } satisfies Record<keyof TableGroupingState, z.ZodTypeAny>)
  .loose();
