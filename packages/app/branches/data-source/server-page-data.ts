import type {
  BranchAnalytics,
  BranchesPageData,
  BranchListResponse,
  BranchQueryFilters,
} from "@repo/api/src/types/branch";
import type { BranchListStatusOrderingResponse } from "@repo/api/src/types/branch-list-contract";
import { ApiError } from "../../shared/api/api-error";
import { reflectToSettled } from "../../shared/lib/reflect-settled";
import type { BranchListOptions } from "./branches-data-source";

export const BRANCH_SERVER_ANALYTICS_STAGGER_MS = 0;

type BranchesStatusOrderingClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
};

export type ServerPageDataReads = {
  readList(filters: BranchListOptions): Promise<BranchListResponse>;
  readAnalytics(filters: BranchQueryFilters): Promise<BranchAnalytics>;
  readLegacy(filters: BranchListOptions): Promise<BranchesPageData>;
  parseCurrentPage(response: BranchListResponse): BranchListResponse | null;
};

export async function readServerPageData(
  filters: BranchListOptions,
  reads: ServerPageDataReads
): Promise<BranchesPageData> {
  const listPromise = reads.readList(filters);
  const stagedAnalytics = stageServerAnalyticsRead(() =>
    reads.readAnalytics(analyticsFilters(filters))
  );
  let list: BranchListResponse;
  try {
    list = await listPromise;
  } catch (error) {
    stagedAnalytics.cancel();
    if (!isLegacyServerPageQueryRejection(error)) {
      throw error;
    }
    return reads.readLegacy(filters);
  }
  const current = reads.parseCurrentPage(list);
  if (!current) {
    stagedAnalytics.cancel();
    return reads.readLegacy(filters);
  }
  const analyticsResult = await stagedAnalytics.result;
  return analyticsResult.status === "rejected" || analyticsResult.value === null
    ? { list: current, analyticsError: true }
    : { list: current, analytics: analyticsResult.value };
}

export async function readBranchListStatusOrdering(
  api: BranchesStatusOrderingClient
): Promise<BranchListStatusOrderingResponse | null> {
  try {
    return parseBranchListStatusOrdering(
      await api.get<unknown>("/branches/list-status-ordering")
    );
  } catch {
    return null;
  }
}

export function analyticsFilters(
  filters: BranchListOptions
): BranchQueryFilters {
  const {
    forceRefresh: _forceRefresh,
    limit: _limit,
    offset: _offset,
    ...analytics
  } = filters;
  return analytics;
}

export function isLegacyServerPageQueryRejection(error: unknown): boolean {
  return (
    isLegacyPageModeRejection(error) || isLegacyServerLimitRejection(error)
  );
}

function isLegacyPageModeRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    error.message.includes("pageMode")
  );
}

function isLegacyServerLimitRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    error.message.includes("server pages require limit=20")
  );
}

function stageServerAnalyticsRead(
  readAnalytics: () => Promise<BranchAnalytics>
): {
  result: Promise<PromiseSettledResult<BranchAnalytics | null>>;
  cancel: () => void;
} {
  let cancel: () => void = () => {};
  const result = reflectToSettled(
    new Promise<BranchAnalytics | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          readAnalytics().then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      }, BRANCH_SERVER_ANALYTICS_STAGGER_MS);
      cancel = () => {
        clearTimeout(timeout);
        resolve(null);
      };
    })
  );
  return { result, cancel };
}

function parseBranchListStatusOrdering(
  response: unknown
): BranchListStatusOrderingResponse | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  // ISS-9437: the served status ordering, rebuilt onto the response only when
  // the producer actually stated one. This parser constructs its result rather
  // than passing the payload through, so an additive field is invisible to the
  // client until it is named here — and a producer that never states one leaves
  // the key ABSENT, which downstream reads as today's behavior rather than as a
  // change of order.
  const statusOrdering = (response as { statusOrdering?: unknown })
    .statusOrdering;
  return typeof statusOrdering === "string" && statusOrdering.length > 0
    ? { statusOrdering }
    : {};
}
