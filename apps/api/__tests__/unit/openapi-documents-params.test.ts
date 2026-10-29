/**
 * Drift guard (ISS-11161) for the published `GET /documents` `offset` bound.
 *
 * `apps/web/content/docs/api-reference/openapi.json` documents this endpoint by
 * hand, so a `maximum` there compiles into a generated client that refuses to
 * send a deeper page. Mirrors `openapi-tags-params.test.ts`: the expectation
 * comes from running the route's validator, never from the spec under test.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findDocumentsQueryValidator } from "@/app/documents/validators";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const openApiPath = path.join(
  repoRoot,
  "apps/web/content/docs/api-reference/openapi.json"
);

type DocumentedParameter = {
  name: string;
  in: string;
  schema?: { type?: string; minimum?: number; maximum?: number };
};

function documentedOffset(): DocumentedParameter {
  const spec = JSON.parse(readFileSync(openApiPath, "utf8")) as {
    paths: Record<
      string,
      Record<string, { parameters?: DocumentedParameter[] }>
    >;
  };
  const parameter = spec.paths["/documents"].get.parameters?.find(
    (p) => p.name === "offset" && p.in === "query"
  );
  if (!parameter) {
    throw new Error('GET /documents does not document an "offset" parameter');
  }
  return parameter;
}

function validatorAcceptsOffset(offset: number): boolean {
  return findDocumentsQueryValidator.safeParse({
    limit: "1",
    offset: String(offset),
  }).success;
}

describe("openapi GET /documents offset", () => {
  it("documents the floor the validator enforces", () => {
    expect(validatorAcceptsOffset(0)).toBe(true);
    expect(validatorAcceptsOffset(-1)).toBe(false);
    expect(documentedOffset().schema?.minimum).toBe(0);
  });

  it("declares exactly the maximum the validator enforces", () => {
    expect(documentedOffset().schema?.maximum).toBe(validatorMaximumOffset());
  });
});

/**
 * The largest offset the validator accepts, found by bisection, or `undefined`
 * when it accepts every safe integer (zod's `.int()` bound). Probing a fixed
 * point just past one known ceiling misses any later, larger one.
 */
function validatorMaximumOffset(): number | undefined {
  if (validatorAcceptsOffset(Number.MAX_SAFE_INTEGER)) {
    return;
  }
  let accepted = 0;
  let rejected = Number.MAX_SAFE_INTEGER;
  while (rejected - accepted > 1) {
    const probe = accepted + Math.floor((rejected - accepted) / 2);
    if (validatorAcceptsOffset(probe)) {
      accepted = probe;
    } else {
      rejected = probe;
    }
  }
  return accepted;
}
