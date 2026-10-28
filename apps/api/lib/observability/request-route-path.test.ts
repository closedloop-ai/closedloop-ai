import { describe, expect, it } from "vitest";
import { readRouteParams, toRouteTemplatePath } from "./request-route-path";

const BRANCH_ID = "019f6b8b-3c2d-7e41-9a10-2b6c8d4e5f70";
const COMMAND_ID = "019f6b8c-0a11-7b22-8c33-4d44e55f6a77";

describe("toRouteTemplatePath (ISS-12274)", () => {
  it.each<{
    pathname: string;
    params: Record<string, string>;
    expected: string;
  }>([
    {
      pathname: `/branches/${BRANCH_ID}`,
      params: { id: BRANCH_ID },
      expected: "/branches/:id",
    },
    {
      pathname: `/compute-targets/${BRANCH_ID}/commands/${COMMAND_ID}`,
      params: { id: BRANCH_ID, commandId: COMMAND_ID },
      expected: "/compute-targets/:id/commands/:commandId",
    },
    {
      pathname: "/documents/by-slug/ISS-12274",
      params: { slug: "ISS-12274" },
      expected: "/documents/by-slug/:slug",
    },
    {
      pathname: "/repos/acme%20corp/widgets",
      params: { owner: "acme corp", repo: "widgets" },
      expected: "/repos/:owner/:repo",
    },
  ])("templates $pathname", ({ pathname, params, expected }) => {
    expect(toRouteTemplatePath(pathname, params)).toBe(expected);
  });

  it("keeps equal values in their own slots", () => {
    expect(
      toRouteTemplatePath("/a/same/b/same", { first: "same", second: "same" })
    ).toBe("/a/:first/b/:second");
  });

  it.each<{
    pathname: string;
    params: Record<string, string>;
  }>([
    { pathname: "/branches/branches", params: { id: "branches" } },
    { pathname: "/desktop/updates/updates", params: { assetName: "updates" } },
    // PR #8608 review: a static SUFFIX named like the id (route
    // `/branches/[id]/activity`) must not be taken for the dynamic segment.
    { pathname: "/branches/activity/activity", params: { id: "activity" } },
  ])(
    "leaves an ambiguous position untemplated: $pathname",
    ({ pathname, params }) => {
      expect(toRouteTemplatePath(pathname, params)).toBe(pathname);
    }
  );

  it("templates an id whose value appears once even beside a static suffix", () => {
    expect(
      toRouteTemplatePath(`/branches/${BRANCH_ID}/activity`, { id: BRANCH_ID })
    ).toBe("/branches/:id/activity");
  });

  it.each([
    { label: "id-free path", params: {} },
    { label: "absent params", params: undefined },
  ])("leaves an $label unchanged", ({ params }) => {
    expect(toRouteTemplatePath("/compute-targets/status-stream", params)).toBe(
      "/compute-targets/status-stream"
    );
  });

  it("ignores an empty or unmatched param value", () => {
    expect(
      toRouteTemplatePath(`/branches/${BRANCH_ID}`, { empty: "", other: "z" })
    ).toBe(`/branches/${BRANCH_ID}`);
  });

  it("compares a malformed percent-encoding verbatim", () => {
    expect(toRouteTemplatePath("/files/%E0%A4%A", { name: "%E0%A4%A" })).toBe(
      "/files/:name"
    );
  });
});

describe("readRouteParams (ISS-12274)", () => {
  it("drops a catch-all value and keeps the single-segment params", async () => {
    await expect(
      readRouteParams({
        params: Promise.resolve({ id: BRANCH_ID, rest: ["a", "b"] }),
      })
    ).resolves.toEqual({ id: BRANCH_ID });
  });

  it("resolves a route context's params", async () => {
    await expect(
      readRouteParams({ params: Promise.resolve({ id: BRANCH_ID }) })
    ).resolves.toEqual({ id: BRANCH_ID });
  });

  it.each([
    { label: "no context", context: () => undefined },
    { label: "a non-object context", context: () => "nope" },
    {
      label: "a rejected params promise",
      context: () => ({ params: Promise.reject(new Error("x")) }),
    },
    {
      label: "a non-string param",
      context: () => ({ params: Promise.resolve({ id: 7 }) }),
    },
  ])("resolves $label to undefined", async ({ context }) => {
    await expect(readRouteParams(context())).resolves.toBeUndefined();
  });
});
