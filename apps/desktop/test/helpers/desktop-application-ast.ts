import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { forEachNode, parseTypeScriptFile } from "./ts-ast.js";

export function findMethodBody(
  sourceFile: ts.SourceFile,
  methodName: string
): ts.Node | undefined {
  let body: ts.Node | undefined;
  forEachNode(sourceFile, (node) => {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === methodName &&
      node.body
    ) {
      body = node.body;
    }
  });
  return body;
}

export function findCloudStatusAssignment(
  root: ts.Node
): ts.BinaryExpression | undefined {
  let found: ts.BinaryExpression | undefined;
  forEachNode(root, (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.left.name.text === "cloudStatus" &&
      ts.isIdentifier(node.right) &&
      node.right.text === "status"
    ) {
      found = node;
    }
  });
  return found;
}

export function findStatusBranch(
  root: ts.Node,
  state: string
): ts.Statement | undefined {
  let branch: ts.Statement | undefined;
  forEachNode(root, (node) => {
    if (
      ts.isIfStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.left) &&
      node.expression.left.name.text === "state" &&
      ts.isStringLiteral(node.expression.right) &&
      node.expression.right.text === state
    ) {
      branch = node.thenStatement;
    }
  });
  return branch;
}

export function parseAppSource(): ts.SourceFile {
  return parseTypeScriptFile(
    fileURLToPath(new URL("../../src/main/app.ts", import.meta.url))
  );
}
