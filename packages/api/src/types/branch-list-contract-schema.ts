import { z } from "zod";
import { BranchStatus } from "./branch.ts";
import {
  BRANCH_LIST_MAX_FILTER_VALUE_LENGTH,
  BRANCH_LIST_MAX_FILTER_VALUES,
  BRANCH_LIST_MAX_OFFSET,
  BRANCH_LIST_MAX_SEARCH_LENGTH,
  BranchListLastActiveRange,
  BranchListPageMode,
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
  type BranchServerPageQuery,
  isBranchListServerPageSize,
} from "./branch-list-contract.ts";
import { PRIORITY_FILTER_VALUES } from "./priority-filter.ts";

const MAX_LOC = 10_000_000;

const stringValuesSchema = z
  .array(z.string().trim().min(1).max(BRANCH_LIST_MAX_FILTER_VALUE_LENGTH))
  .max(BRANCH_LIST_MAX_FILTER_VALUES)
  .optional();

export const branchServerPageQueryShape = {
  pageMode: z.literal(BranchListPageMode.Server),
  limit: z.number().int().refine(isBranchListServerPageSize, {
    message: "unsupported Branches server page size",
  }),
  offset: z.number().int().min(0).max(BRANCH_LIST_MAX_OFFSET),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  names: stringValuesSchema,
  owners: stringValuesSchema,
  collaborators: stringValuesSchema,
  statuses: z
    .array(z.enum(Object.values(BranchStatus)))
    .max(BRANCH_LIST_MAX_FILTER_VALUES)
    .optional(),
  pullRequests: z
    .array(z.enum(Object.values(BranchListPullRequestPresence)))
    .max(BRANCH_LIST_MAX_FILTER_VALUES)
    .optional(),
  lastActiveRanges: z
    .array(z.enum(Object.values(BranchListLastActiveRange)))
    .max(BRANCH_LIST_MAX_FILTER_VALUES)
    .optional(),
  repositories: stringValuesSchema,
  tags: stringValuesSchema,
  priorities: z
    .array(z.enum(PRIORITY_FILTER_VALUES))
    .max(BRANCH_LIST_MAX_FILTER_VALUES)
    .optional(),
  locMin: z.number().int().min(0).max(MAX_LOC).optional(),
  locMax: z.number().int().min(0).max(MAX_LOC).optional(),
  search: z
    .string()
    .trim()
    .min(1)
    .max(BRANCH_LIST_MAX_SEARCH_LENGTH)
    .optional(),
  sortKey: z.enum(Object.values(BranchListSortKey)),
  sortDir: z.enum(Object.values(BranchListSortDirection)),
} satisfies Record<keyof BranchServerPageQuery, z.ZodTypeAny>;

/** Strict process-boundary validation for the additive server-page request. */
export const branchServerPageQuerySchema = z
  .object(branchServerPageQueryShape)
  .strict()
  .refine(
    (query) =>
      query.locMin === undefined ||
      query.locMax === undefined ||
      query.locMin <= query.locMax,
    { message: "locMin must be less than or equal to locMax", path: ["locMin"] }
  )
  .refine((query) => query.offset % query.limit === 0, {
    message: "server pages require an aligned offset",
    path: ["offset"],
  });
