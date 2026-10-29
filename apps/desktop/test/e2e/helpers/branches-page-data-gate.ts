import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";
import {
  ListFilterOperator,
  type ListQueryExpression,
} from "@repo/api/src/types/list-query-expression.ts";
import { BranchListField } from "@repo/api/src/types/list-query-fields.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATE_KEY = "__clE2eBranchesPageDataGate";

/** Install the Branches IPC gate before the Desktop main entrypoint. */
export function branchesPageDataGateLaunchArgs(enabled: boolean): string[] {
  return enabled
    ? ["-r", path.join(__dirname, "branches-page-data-gate-preload.cjs")]
    : [];
}

/** Start holding every future Branches page-data response. */
export function armBranchesPageDataGate(
  app: ElectronApplication
): Promise<number> {
  return callGate<number>(app, { operation: "arm" });
}

/** From now on, add one unknown key inside each nested page-data object (ISS-8884). */
export function enableBranchesPageDataSkew(
  app: ElectronApplication
): Promise<number> {
  return callGate<number>(app, { operation: "skew" });
}

/** Read the currently held response ids and their exact producer requests. */
export async function readHeldBranchesPageData(
  app: ElectronApplication
): Promise<HeldBranchesPageData[]> {
  const held = await callGate<HeldBranchesPageData[]>(app, {
    operation: "snapshot",
  });
  return held.map(withLegacyWindow);
}

/** Read cumulative Branches page-data gate counters and dispatched requests. */
export async function readBranchesPageDataGateStats(
  app: ElectronApplication
): Promise<BranchesPageDataGateStats> {
  const stats = await callGate<BranchesPageDataGateStats>(app, {
    operation: "stats",
  });
  return { ...stats, requests: stats.requests.map(withLegacyWindow) };
}

/** Release one held response by id. */
export function releaseHeldBranchesPageData(
  app: ElectronApplication,
  id: number
): Promise<number> {
  return callGate<number>(app, { id, operation: "release" });
}

/** Reject one held response by id. */
export function rejectHeldBranchesPageData(
  app: ElectronApplication,
  id: number
): Promise<number> {
  return callGate<number>(app, { id, operation: "reject" });
}

function callGate<T>(
  app: ElectronApplication,
  request: GateRequest
): Promise<T> {
  return app.evaluate(
    (_electron, input) => {
      const gate = Reflect.get(globalThis, input.key) as
        | BranchesPageDataGate
        | undefined;
      if (!gate) {
        throw new Error(
          "the Branches page-data gate preload was never installed"
        );
      }
      if (input.operation === "arm") {
        return gate.arm();
      }
      if (input.operation === "skew") {
        return gate.skew();
      }
      if (input.operation === "snapshot") {
        return gate.snapshot();
      }
      if (input.operation === "stats") {
        return gate.stats();
      }
      if (input.id === undefined) {
        throw new Error(
          `the Branches page-data ${input.operation} id is missing`
        );
      }
      return input.operation === "release"
        ? gate.release(input.id)
        : gate.reject(input.id);
    },
    { ...request, key: GATE_KEY }
  ) as Promise<T>;
}

export type HeldBranchesPageData = {
  id: number;
  request: {
    startDate?: string;
    endDate?: string;
    pageMode?: string;
    listQuery?: ListQueryExpression;
  };
};

export type BranchesPageDataGateStats = {
  dispatched: number;
  settled: number;
  pending: number;
  requests: HeldBranchesPageData[];
};

type GateOperation =
  | "arm"
  | "skew"
  | "snapshot"
  | "stats"
  | "release"
  | "reject";

type GateRequest = {
  operation: GateOperation;
  id?: number;
};

type BranchesPageDataGate = {
  arm: () => number;
  skew: () => number;
  snapshot: () => HeldBranchesPageData[];
  stats: () => BranchesPageDataGateStats;
  release: (id: number) => number;
  reject: (id: number) => number;
};

/**
 * The recorded request's date window wherever the grid put it: the legacy
 * `startDate`/`endDate`, or (PRD-721, #9126) the last-activity window clause
 * of its `listQuery`, which main lowers back to those same params.
 */
function withLegacyWindow(held: HeldBranchesPageData): HeldBranchesPageData {
  const window = held.request.listQuery?.filters?.find(
    (filter) =>
      filter.field === BranchListField.LastActivity &&
      filter.operator === ListFilterOperator.IsBetween
  );
  if (!(window && ("min" in window || "max" in window))) {
    return held;
  }
  return {
    ...held,
    request: {
      ...held.request,
      ...(typeof window.min === "string" ? { startDate: window.min } : {}),
      ...(typeof window.max === "string" ? { endDate: window.max } : {}),
    },
  };
}
