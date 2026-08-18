import { describe, expect, it } from "vitest";
import {
  BranchViewLocalGatewayPath,
  BranchViewLocalOperationId,
  getBranchViewLocalGatewayPathname,
  isBranchViewLocalGatewayPath,
  isBranchViewLocalOperationId,
  resolveBranchViewLocalOperationId,
} from "./branch-view-local.ts";

describe("branch view local gateway paths", () => {
  it("recognizes every supported path while ignoring query and fragment suffixes", () => {
    expect(isBranchViewLocalGatewayPath(BranchViewLocalGatewayPath.List)).toBe(
      true
    );
    expect(isBranchViewLocalGatewayPath(BranchViewLocalGatewayPath.Diff)).toBe(
      true
    );
    expect(
      isBranchViewLocalGatewayPath(
        `${BranchViewLocalGatewayPath.CommitPush}?confirm=true#result`
      )
    ).toBe(true);
    expect(isBranchViewLocalGatewayPath("/api/gateway/git/status")).toBe(false);
  });

  it("normalizes relative and absolute gateway URLs to their pathname", () => {
    expect(
      getBranchViewLocalGatewayPathname(
        `https://desktop.local${BranchViewLocalGatewayPath.Diff}?file=README.md`
      )
    ).toBe(BranchViewLocalGatewayPath.Diff);
  });

  it.each([
    [BranchViewLocalGatewayPath.List, BranchViewLocalOperationId.Read],
    [BranchViewLocalGatewayPath.Diff, BranchViewLocalOperationId.Read],
    [
      BranchViewLocalGatewayPath.CommitPush,
      BranchViewLocalOperationId.CommitPush,
    ],
    ["/api/gateway/git/status", null],
  ])("maps %s to operation %s", (path, operationId) => {
    expect(resolveBranchViewLocalOperationId(path)).toBe(operationId);
  });

  it("normalizes a malformed path instead of throwing", () => {
    // Callers now hand this stored `requestPayload.path` values, which are
    // arbitrary JSON strings. Throwing inside an authorization check would turn
    // a corrupt row into a 500 rather than a denial.
    expect(getBranchViewLocalGatewayPathname("http://[zz]/x?y=1")).toBe(
      "http://[zz]/x"
    );
    expect(isBranchViewLocalGatewayPath("http://[zz]/x")).toBe(false);
  });

  it.each([
    [BranchViewLocalOperationId.Read, true],
    [BranchViewLocalOperationId.CommitPush, true],
    ["symphony_chat", false],
    ["", false],
    [undefined, false],
    [null, false],
  ])("classifies the stored operation id %s as %s", (value, expected) => {
    // The replay side classifies a stored command off this id, so a value it
    // fails to recognize is a command that escapes the Branch View author gate.
    expect(isBranchViewLocalOperationId(value)).toBe(expected);
  });
});
