/**
 * ISS-12552 (PRD-800 "Rollout"): the historical parse worker cannot see
 * the flag, so main sends the parse policy on each request as data. A request
 * without it (from a main that predates it) parses under the base policy, and
 * a worker that predates it strips the field and parses as it always did.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, test } from "vitest";
import {
  handleHistoricalParseRequest,
  resetWorkerCollectorsForTesting,
} from "../src/main/collectors/engine/historical-parse-source.js";
import {
  type HistoricalParseWorkerRequest,
  HistoricalParseWorkerRequestType,
  historicalParseWorkerRequestSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { createUtilityProcessHistoricalParseRunner } from "../src/main/collectors/engine/utility-process-historical-parse-runner.js";
import {
  Harness,
  type HarnessCollector,
} from "../src/main/collectors/types.js";
import { effectiveParsePolicy } from "../src/main/parse-policy/effective-parse-policy.js";
import {
  PARSE_POLICY_ATTRIBUTION,
  PARSE_POLICY_BASE,
  type ParsePolicy,
} from "../src/main/parse-policy/parse-policy.js";

const ROOT = mkdtempSync(path.join(tmpdir(), "iss12552-worker-policy-"));
const SOURCE = path.join(ROOT, "session.jsonl");
writeFileSync(SOURCE, "");

afterEach(() => {
  resetWorkerCollectorsForTesting();
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function request(parsePolicy?: ParsePolicy): HistoricalParseWorkerRequest {
  return historicalParseWorkerRequestSchema.parse({
    type: HistoricalParseWorkerRequestType.ParseSource,
    requestId: "request-1",
    collectorKey: Harness.Claude,
    source: SOURCE,
    ...(parsePolicy ? { parsePolicy } : {}),
  });
}

/** A worker collector that records the policy each parse ran under. */
function recordingCollectors(): {
  built: number;
  seen: boolean[];
} {
  const record = { built: 0, seen: [] as boolean[] };
  resetWorkerCollectorsForTesting((key) => {
    record.built += 1;
    const collector: HarnessCollector = {
      key,
      cacheName: key,
      watchRoots: () => [ROOT],
      watchMatch: () => true,
      listSources: () => [SOURCE],
      parse: () => {
        record.seen.push(effectiveParsePolicy().attributionEvidence);
        return Promise.resolve([]);
      },
    };
    return collector;
  });
  return record;
}

describe("the parse policy on the worker request", () => {
  test("survives the request schema, and an unknown later field is stripped", () => {
    assert.deepEqual(
      request(PARSE_POLICY_ATTRIBUTION).parsePolicy,
      PARSE_POLICY_ATTRIBUTION
    );
    assert.equal(request().parsePolicy, undefined);
    const later = historicalParseWorkerRequestSchema.parse({
      ...request(PARSE_POLICY_ATTRIBUTION),
      parsePolicy: { attributionEvidence: true, laterField: 1 },
      laterTopLevelField: true,
    });
    assert.deepEqual(later.parsePolicy, PARSE_POLICY_ATTRIBUTION);
    assert.equal(Object.hasOwn(later, "laterTopLevelField"), false);
  });

  test("a worker that predates the field strips it and parses as before", () => {
    const olderWorkerSchema = historicalParseWorkerRequestSchema.omit({
      parsePolicy: true,
    });
    const parsed = olderWorkerSchema.parse(request(PARSE_POLICY_ATTRIBUTION));
    assert.equal(Object.hasOwn(parsed, "parsePolicy"), false);
  });

  test("the worker parses under the request's policy, and base without one", async () => {
    const record = recordingCollectors();

    await handleHistoricalParseRequest(request());
    await handleHistoricalParseRequest(request(PARSE_POLICY_ATTRIBUTION));
    await handleHistoricalParseRequest(request(PARSE_POLICY_ATTRIBUTION));
    await handleHistoricalParseRequest(request(PARSE_POLICY_BASE));

    assert.deepEqual(record.seen, [false, true, true, false]);
    // One collector per policy run: a change drops the warmed cache, the same
    // policy reuses it.
    assert.equal(record.built, 3);
  });

  test("the runner posts the caller's policy and omits an absent one", async () => {
    const posted: unknown[] = [];
    const runner = createUtilityProcessHistoricalParseRunner({
      log: () => undefined,
      forkWorker: () => {
        const child = Object.assign(new EventEmitter(), {
          stderr: new EventEmitter(),
          postMessage: (message: unknown) => {
            posted.push(message);
          },
          kill: () => undefined,
        });
        return child;
      },
    });
    const withPolicy = runner
      .parseSource(
        Harness.Claude,
        SOURCE,
        undefined,
        undefined,
        PARSE_POLICY_ATTRIBUTION
      )
      .catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    await withPolicy;
    const withoutPolicy = runner
      .parseSource(Harness.Claude, SOURCE)
      .catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    runner.stop();
    await withoutPolicy;

    const policies = posted.map(
      (message) => historicalParseWorkerRequestSchema.parse(message).parsePolicy
    );
    assert.deepEqual(policies, [PARSE_POLICY_ATTRIBUTION, undefined]);
  });
});
