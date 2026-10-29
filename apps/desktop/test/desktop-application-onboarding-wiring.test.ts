import assert from "node:assert/strict";
import ts from "typescript6";
import { describe, test } from "vitest";
import {
  findCloudStatusAssignment,
  findMethodBody,
  findStatusBranch,
  parseAppSource,
} from "./helpers/desktop-application-ast.js";
import { forEachNode } from "./helpers/ts-ast.js";

describe("ISS-12420: production onboarding lifecycle wiring", () => {
  test("production online callback refreshes analytics after applying readiness", () => {
    const body = findMethodBody(parseAppSource(), "onCloudSocketStatus");
    assert.ok(body);
    const online = findStatusBranch(body, "online");
    assert.ok(online);
    let refresh: ts.CallExpression | undefined;
    forEachNode(online, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "refreshAnalyticsReadiness" &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "observabilityLaneRouter"
      ) {
        refresh = node;
      }
    });
    assert.ok(
      refresh,
      "online callback must wake the pending onboarding queue"
    );
    const assignment = findCloudStatusAssignment(body);
    assert.ok(assignment);
    assert.ok(refresh.pos > assignment.end);
  });

  test("shutdown disposes analytics only after the shutdown flush settles", () => {
    const body = findMethodBody(parseAppSource(), "shutdown");
    assert.ok(body);
    const disposals: ts.CallExpression[] = [];
    let finallyCall: ts.CallExpression | undefined;
    forEachNode(body, (node) => {
      if (
        !(
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression)
        )
      ) {
        return;
      }
      if (
        node.expression.name.text === "dispose" &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "observabilityLaneRouter"
      ) {
        disposals.push(node);
      }
      const receiver = node.expression.expression;
      if (
        node.expression.name.text === "finally" &&
        ts.isCallExpression(receiver) &&
        ts.isIdentifier(receiver.expression) &&
        receiver.expression.text === "runDesktopApplicationShutdown"
      ) {
        finallyCall = node;
      }
    });
    assert.equal(disposals.length, 1);
    assert.ok(
      finallyCall,
      "shutdown must retain analytics until the bounded flush settles"
    );
    const callback = finallyCall.arguments[0];
    assert.ok(callback);
    assert.ok(
      disposals[0].pos >= callback.pos && disposals[0].end <= callback.end
    );
  });
});
