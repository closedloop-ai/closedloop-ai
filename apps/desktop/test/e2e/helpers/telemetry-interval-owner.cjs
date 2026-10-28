"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { createRequire } = require("node:module");
const ownerFramePattern =
  /^\s*at ClaudeCodeTelemetrySyncService\.start \((.+):(\d+):(\d+)\)$/;
const canonicalCadence = 15_000;

/** Resolve the supported entry supplied by the real Electron launcher. */
function desktopFromMainArgs(argv) {
  const entries = argv.filter(
    (arg) =>
      typeof arg === "string" &&
      path.isAbsolute(arg) &&
      path.basename(arg) === "index.js" &&
      path.basename(path.dirname(arg)) === "main" &&
      path.basename(path.dirname(path.dirname(arg))) === "dist"
  );
  if (entries.length !== 1) {
    throw new Error(
      "Telemetry clock requires one canonical Desktop MAIN entry."
    );
  }
  const entry = fs.realpathSync(entries[0]);
  const desktop = path.dirname(path.dirname(path.dirname(entry)));
  if (fs.realpathSync(path.join(desktop, "dist/main/index.js")) !== entry) {
    throw new Error("Desktop MAIN entry is not canonical.");
  }
  return desktop;
}

/** Qualify the current callback against its actual built class and call site. */
function createOwnerQualifier(desktop) {
  const desktopRequire = createRequire(path.join(desktop, "package.json"));
  const ts = desktopRequire("typescript6");
  const mainDirectory = fs.realpathSync(path.join(desktop, "dist/main"));
  function member(node, name) {
    return (
      Boolean(node) &&
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.name.text === name
    );
  }
  function call(node, name) {
    return (
      Boolean(node) &&
      ts.isCallExpression(node) &&
      member(node.expression, name) &&
      node.arguments.length === 0
    );
  }
  function assignment(node, name) {
    return (
      Boolean(node) &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      member(node.left, name)
    );
  }
  function tickArrow(node) {
    return (
      ts.isArrowFunction(node) &&
      node.parameters.length === 0 &&
      !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) &&
      call(node.body, "kick")
    );
  }
  function className(node) {
    if (node.name && ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    if (
      ts.isClassExpression(node) &&
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    ) {
      return node.parent.name.text;
    }
    return null;
  }
  function sharedTickReturn(statement) {
    if (ts.isBlock(statement)) {
      return (
        statement.statements.length === 1 &&
        sharedTickReturn(statement.statements[0])
      );
    }
    return (
      ts.isReturnStatement(statement) && member(statement.expression, "tick")
    );
  }
  function requireKickPromise(ownerClass) {
    const kicks = ownerClass.members.filter(
      (n) =>
        ts.isMethodDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "kick"
    );
    const kick = kicks.length === 1 ? kicks[0] : null;
    if (
      !kick ||
      kick.asteriskToken ||
      kick.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      throw new Error(
        "Telemetry kick is not the single original promise-returning method."
      );
    }
    const drains = ownerClass.members.filter(
      (n) =>
        ts.isMethodDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "syncOnce"
    );
    if (
      drains.length !== 1 ||
      !drains[0].modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      throw new Error(
        "Telemetry drain is not its single existing async method."
      );
    }
    const statements = kick?.body?.statements;
    if (statements?.length !== 3) {
      throw new Error("Telemetry completion owner shape changed.");
    }
    const [guard, set, result] = statements;
    const guardedReturn =
      ts.isIfStatement(guard) &&
      member(guard.expression, "tick") &&
      !guard.elseStatement &&
      sharedTickReturn(guard.thenStatement);
    if (
      !(
        guardedReturn &&
        ts.isExpressionStatement(set) &&
        assignment(set.expression, "tick") &&
        ts.isReturnStatement(result) &&
        member(result.expression, "tick")
      )
    ) {
      throw new Error(
        "Telemetry completion does not share its admission promise."
      );
    }
    const drain = set.expression.right;
    if (
      !ts.isCallExpression(drain) ||
      drain.arguments.length !== 1 ||
      !ts.isPropertyAccessExpression(drain.expression) ||
      drain.expression.name.text !== "finally" ||
      !call(drain.expression.expression, "syncOnce")
    ) {
      throw new Error(
        "Telemetry completion does not include the existing final drain."
      );
    }
    const reset = drain.arguments[0];
    if (
      !ts.isArrowFunction(reset) ||
      reset.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
      reset.parameters.length ||
      !ts.isBlock(reset.body) ||
      reset.body.statements.length !== 1 ||
      !ts.isExpressionStatement(reset.body.statements[0]) ||
      !assignment(reset.body.statements[0].expression, "tick") ||
      reset.body.statements[0].expression.right.kind !==
        ts.SyntaxKind.NullKeyword
    ) {
      throw new Error(
        "Telemetry completion does not include its final admission reset."
      );
    }
  }
  function proveCadence(source, start, argument) {
    if (!ts.isIdentifier(argument)) {
      throw new Error("Telemetry interval binding unavailable.");
    }
    const bindings = start.body.statements
      .filter(ts.isVariableStatement)
      .flatMap((s) => [...s.declarationList.declarations])
      .filter((d) => ts.isIdentifier(d.name) && d.name.text === argument.text);
    const init = bindings.length === 1 ? bindings[0].initializer : null;
    if (
      !(init && ts.isBinaryExpression(init)) ||
      init.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
      !ts.isPropertyAccessExpression(init.left) ||
      init.left.name.text !== "intervalMs" ||
      !member(init.left.expression, "options")
    ) {
      throw new Error(
        "Telemetry interval no longer uses its existing option/default binding."
      );
    }
    let value = init.right;
    if (ts.isIdentifier(value)) {
      const defaults = source.statements
        .filter(ts.isVariableStatement)
        .flatMap((s) => [...s.declarationList.declarations])
        .filter((d) => ts.isIdentifier(d.name) && d.name.text === value.text);
      value = defaults.length === 1 ? defaults[0].initializer : null;
    }
    if (
      !(value && ts.isNumericLiteral(value)) ||
      Number(value.text) !== canonicalCadence
    ) {
      throw new Error(
        "Canonical telemetry cadence changed or cannot be resolved."
      );
    }
  }
  function resolveFrame(filename, line, column) {
    const actualFile = fs.realpathSync(
      filename.startsWith("file:") ? fileURLToPath(filename) : filename
    );
    const relative = path.relative(mainDirectory, actualFile);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      path.extname(actualFile) !== ".js"
    ) {
      throw new Error(
        "Telemetry frame is outside the current built MAIN artifact."
      );
    }
    const source = ts.createSourceFile(
      actualFile,
      fs.readFileSync(actualFile, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    if (source.parseDiagnostics.length) {
      throw new Error("Actual built owner module cannot be parsed.");
    }
    const row = Number(line) - 1,
      col = Number(column) - 1;
    const lineStarts = source.getLineStarts();
    if (
      !(Number.isSafeInteger(row) && Number.isSafeInteger(col)) ||
      row < 0 ||
      row >= lineStarts.length ||
      col < 0
    ) {
      throw new Error("Actual owner frame position unavailable.");
    }
    const position = lineStarts[row] + col;
    if (position >= (lineStarts[row + 1] ?? source.end)) {
      throw new Error("Actual owner frame column unavailable.");
    }
    return { source, position, relative };
  }
  function requireCurrentOwner(source, position) {
    let intervalCall = null,
      ownerClass = null,
      start = null;
    const classes = [];
    function visit(node) {
      if (
        (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
        className(node) === "ClaudeCodeTelemetrySyncService"
      ) {
        classes.push(node);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "setInterval" &&
        node.getStart(source) <= position &&
        position < node.end
      ) {
        if (intervalCall) {
          throw new Error("Ambiguous owner call site.");
        }
        intervalCall = node;
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (
      intervalCall?.arguments.length !== 2 ||
      !tickArrow(intervalCall.arguments[0])
    ) {
      throw new Error(
        "Actual owner call does not register the returned telemetry arrow."
      );
    }
    let ancestor = intervalCall.parent;
    while (ancestor && !ts.isMethodDeclaration(ancestor)) {
      ancestor = ancestor.parent;
    }
    start = ancestor;
    ownerClass = start?.parent;
    if (
      !(start && ts.isIdentifier(start.name)) ||
      start.name.text !== "start" ||
      !ownerClass ||
      classes.length !== 1 ||
      classes[0] !== ownerClass
    ) {
      throw new Error("Call site is not the unique telemetry service start.");
    }
    const starts = ownerClass.members.filter(
      (n) =>
        ts.isMethodDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "start"
    );
    if (starts.length !== 1 || starts[0] !== start) {
      throw new Error("Telemetry start is not unique.");
    }
    if (
      !assignment(intervalCall.parent, "timer") ||
      intervalCall.parent.right !== intervalCall
    ) {
      throw new Error(
        "Periodic handle is not assigned to its existing lifecycle owner."
      );
    }
    return { intervalCall, ownerClass, start };
  }
  function requireRuntimeArrow(callback) {
    const callbackSource = ts.createSourceFile(
      "runtime-callback.js",
      `const callback = (${Function.prototype.toString.call(callback)});`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const observedArrow =
      callbackSource.statements[0]?.declarationList?.declarations[0]
        ?.initializer;
    const observed =
      observedArrow && ts.isParenthesizedExpression(observedArrow)
        ? observedArrow.expression
        : observedArrow;
    if (
      callbackSource.parseDiagnostics.length ||
      !observed ||
      !tickArrow(observed)
    ) {
      throw new Error(
        "Runtime callback does not match the actual owned returned arrow."
      );
    }
  }
  return function qualify(callback, delay, stack) {
    const frames = String(stack)
      .split("\n")
      .map((line) => line.match(ownerFramePattern))
      .filter(Boolean);
    if (!frames.length) {
      return null;
    }
    if (
      frames.length !== 1 ||
      typeof callback !== "function" ||
      delay !== canonicalCadence
    ) {
      throw new Error("Ambiguous telemetry owner or cadence.");
    }
    const [, filename, line, column] = frames[0];
    const { source, position, relative } = resolveFrame(filename, line, column);
    const { intervalCall, ownerClass, start } = requireCurrentOwner(
      source,
      position
    );
    requireRuntimeArrow(callback);
    proveCadence(source, start, intervalCall.arguments[1]);
    requireKickPromise(ownerClass);
    return {
      sourceQualified: true,
      canonicalCadence,
      moduleRelative: relative,
      ownerClass: "ClaudeCodeTelemetrySyncService",
      ownerMethod: "start",
      runtimePositionObserved: { line: Number(line), column: Number(column) },
      noPrecomputedLocationOrHash: true,
    };
  };
}
module.exports = { desktopFromMainArgs, createOwnerQualifier };
