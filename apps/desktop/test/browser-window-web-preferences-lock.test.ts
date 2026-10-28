/**
 * @file browser-window-web-preferences-lock.test.ts
 * @description ISS-6710 — the renderer trust boundary: the `webPreferences`
 * `src/main/window.ts` hands `new BrowserWindow({ ... })`.
 *
 * WHY IT NEEDS A GUARD. `apps/desktop/AGENTS.md` records this lock
 * (`contextIsolation: true`, no `nodeIntegration`, `sandbox: false`) as one of
 * two invariants the retired `test/agent-dashboard-boundary.test.ts` AST-checked
 * and that "neither is currently guarded". It is not something
 * dependency-cruiser can express — it is a value inside a call argument, not an
 * edge in the module graph — and `git grep contextIsolation -- apps/desktop`
 * returns exactly one source hit, this one. The repo's own Electron reviewer
 * note (`resources/audit-characters/marisolashgrove/electron-eli.md`) states the
 * consequence: with `sandbox: false` the preload runs with Node privileges, so a
 * renderer that reaches it through a lowered `contextIsolation` is an RCE
 * surface, not a bug. A PR that flipped it compiled, shipped, and reddened
 * nothing.
 *
 * NOT a resurrection of the retired file, and not the thing
 * `test/window-default-size.test.ts` declines to do: that suite deliberately
 * does not re-assert the security config inside ITSELF (its subject is the
 * default window size), and AGENTS.md's instruction is to "reinstate as a
 * dedicated behavioral test … never by extending a deleted file". This is that
 * dedicated file.
 *
 * HOW. `window.ts` statically imports `electron`, so it cannot be loaded here;
 * the structural half uses the sanctioned `ts.createSourceFile` parse (shared
 * plumbing in `helpers/window-source-ast.ts`) and asserts on the PARSED property
 * set — the key's initializer node kind, never the source text. A raw-text
 * `assert.match(source, /contextIsolation:\s*true/)` would be banned
 * (`scripts/lint/rules/no-raw-text-source-scan.ts`), satisfiable by a COMMENT,
 * and — the reason it would be worthless even if it were allowed — blind to
 * `nodeIntegration: true` being ADDED, which is the mutation that actually opens
 * the surface. Hence {@link REVIEWED_WEB_PREFERENCES_KEYS}: every key present
 * must have been reviewed, so a weakening key that is not on the pin list fails
 * here instead of arriving unnoticed.
 *
 * The spread is the other half of that hole. `webPreferences` mixes in
 * `...windowRevealSuppressedWebPreferences(...)`, and a spread can contribute
 * any key at all — LAST, so it overrides the literal — which would make the
 * allow-list above it prove nothing on its own. The spread expressions are
 * pinned structurally to a one-entry allow-list, and that one helper (which is
 * electron-free) is then driven for BOTH of its inputs and put through
 * {@link webPreferenceViolation}: the SAME policy function the literal goes
 * through, not a second copy of it. That is deliberate — a parallel copy of the
 * policy for the spread half that happened to omit `contextIsolation` would let
 * the helper turn the lock off with every assertion in this file green.
 *
 * SCOPE IS THE WHOLE `src` TREE, and both doors into it. One structural sweep
 * parses every `.ts`/`.tsx` file under `src` and reports two things: every
 * `new BrowserWindow(...)` and every `webPreferences` literal. Neither alone is
 * a guard on the boundary. A window constructed in a SIBLING module carries its
 * own preferences that a `window.ts`-scoped assertion never reads; and a
 * `webPreferences` can reach Chromium with no construction in the diff at all,
 * via a `setWindowOpenHandler` returning `overrideBrowserWindowOptions` for a
 * child window that inherits this window's privileged preload. The key policy
 * runs over every literal the sweep found, wherever it was found.
 *
 * The sweep has its own counterfactual, because a whole-tree scan is the easiest
 * kind of guard to make vacuous: a walk that resolves to no files finds no
 * second construction and no unreviewed key, and reads exactly like a clean
 * tree. So {@link MINIMUM_SWEPT_FILES_BY_SUBTREE} and
 * {@link MINIMUM_SWEPT_TSX_FILES} pin the population with literals written
 * independently of the walk.
 *
 * WHAT THIS FILE DOES NOT COVER, stated because a green guard retires the human
 * attention that was compensating, and a reader who mistakes its scope for
 * "Electron security config" gets that retirement for free. It reads exactly two
 * shapes — a `BrowserWindow` construction and a `webPreferences` object literal.
 * Every other Chromium-facing control in this app is somebody else's:
 *
 * - the Content-Security-Policy installed on `session.defaultSession`
 *   (`startup.ts`), and any other `session` handler, e.g. a permission-request
 *   handler that started granting everything;
 * - the `app://` scheme privileges granted by `protocol.registerSchemesAsPrivileged`
 *   (`app-scheme.ts`) — `bypassCSP` there is a one-word renderer escalation with
 *   no `webPreferences` in sight;
 * - process-global Chromium switches via `app.commandLine.appendSwitch`
 *   (`startup.ts`);
 * - the navigation and `shell.openExternal` allowlists, which
 *   `external-url-allowlist.test.ts` owns behaviorally;
 * - and a `webPreferences` written with a key this parse cannot resolve — a
 *   computed key built from a non-literal expression. Every spelling a person
 *   writes by hand (identifier, string literal, computed string literal,
 *   shorthand, accessor) is either read or thrown on; a dynamically-built key is
 *   neither, and no assertion here should be read as covering one.
 *
 * Green here means the `webPreferences` lock holds. It does not mean the app's
 * renderer security posture is unchanged.
 */

import assert from "node:assert/strict";
import path from "node:path";
import type { ObjectLiteralExpression, SourceFile } from "typescript6";
import {
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  SyntaxKind,
} from "typescript6";
import { test } from "vitest";
import { windowRevealSuppressedWebPreferences } from "../src/main/lifecycle/window-reveal-suppression.js";
import {
  countBrowserWindowConstructions,
  findBrowserWindowOptions,
  findWebPreferences,
  parseWindowSource,
  type RendererTrustBoundaryScan,
  scanDesktopSourceForRendererTrustBoundary,
  topLevelPropertyValueText,
} from "./helpers/window-source-ast.js";

/**
 * The module that is allowed to open a renderer trust boundary, relative to
 * `src`.
 *
 * One module, one window, one `webPreferences`. Both halves of the sweep are
 * pinned to it: a `new BrowserWindow` anywhere else is a second boundary with
 * its own preferences, and a `webPreferences` literal anywhere else reaches
 * Chromium through `setWindowOpenHandler`'s `overrideBrowserWindowOptions`
 * without ever constructing a window this file would notice.
 */
const RENDERER_TRUST_BOUNDARY_MODULE =
  "main/lifecycle/create-desktop-browser-window.ts";

/**
 * Per-subtree floors on the population the sweep must have visited, written here
 * rather than derived from it.
 *
 * This is the counterfactual for the sweep ITSELF, and it is deliberately not a
 * single total. A total can only catch a walk that reached NOTHING, which is the
 * easy failure; the one that actually costs something is a walk that quietly
 * drops a SUBTREE and still returns a big number. `src/main` alone is 977 files,
 * so a total-only floor of any useful value survives deleting `src/server`,
 * `src/shared` and `src/renderer` outright — losing exactly the directories the
 * widening to the whole tree exists for. Each subtree therefore answers for
 * itself.
 *
 * `collectTsFiles` is shared with two other guardrail suites that scope it
 * differently, so a filter added there for one of them would narrow this
 * security guard's population silently. That is the mutation these floors are
 * pointed at.
 *
 * Counts when written: main 977, renderer 541, server 99, shared 82. Floors sit
 * well below so ordinary deletions do not trip them. `server` was lowered after
 * #8952 and #8975 deleted dead gateway code and left 59 files there.
 */
const MINIMUM_SWEPT_FILES_BY_SUBTREE: ReadonlyMap<string, number> = new Map([
  ["main", 700],
  ["renderer", 400],
  ["server", 40],
  ["shared", 50],
]);

/**
 * A floor on the `.tsx` files swept, for the same reason at the extension axis.
 *
 * The sweep parses every file as `ScriptKind.TS`, so a maintainer narrowing
 * `collectTsFiles` to `.ts` would look like a tidy-up rather than the removal of
 * 342 files from a security guard's population. 200 of the 342 is the floor.
 */
const MINIMUM_SWEPT_TSX_FILES = 200;

/**
 * Must be present and literally `true`.
 *
 * The single load-bearing key: it is what keeps the renderer's JS world separate
 * from the preload's privileged one.
 */
const MUST_BE_TRUE_KEYS = ["contextIsolation"] as const;

/**
 * Must be present and literally `false`.
 *
 * `sandbox: false` is deliberate and load-bearing in BOTH directions, which is
 * why it is pinned rather than filed as reviewed-neutral. Downward it cannot go
 * — it is already at the weak end. Upward it cannot go silently either: the
 * preload resolves Electron through `createRequire`
 * (`src/main/preload-common.ts:983`), which a sandboxed preload cannot do, so
 * raising it breaks the bridge at runtime in a way no unit test would see.
 *
 * It is also the premise of the `contextIsolation` failure message below: "the
 * preload runs with Node privileges" is a true statement about the severity of
 * lowering `contextIsolation` only while `sandbox` is `false`. A key that other
 * assertions reason FROM is a key that has to be pinned, or those assertions are
 * reasoning from an assumption nothing checks. Raising it is a real
 * strengthening and this guard should be edited to allow it — deliberately, in
 * the same change, having re-read the preload.
 */
const MUST_BE_FALSE_KEYS = ["sandbox"] as const;

/**
 * May be omitted; if written, must be literally `false`.
 *
 * Each of these hands the renderer — or a frame it can create — capabilities the
 * trust boundary exists to withhold: Node globals in the page or in a subframe
 * or worker, an embeddable `<webview>`, mixed-content loads, and Chromium's
 * experimental web platform features.
 */
const MUST_BE_FALSE_IF_PRESENT_KEYS = [
  "nodeIntegration",
  "nodeIntegrationInWorker",
  "nodeIntegrationInSubFrames",
  "webviewTag",
  "allowRunningInsecureContent",
  "experimentalFeatures",
] as const;

/** May be omitted (Electron defaults it on); if written, must be literally `true`. */
const MUST_BE_TRUE_IF_PRESENT_KEYS = ["webSecurity"] as const;

/**
 * Reviewed and deliberately NOT value-pinned.
 *
 * `additionalArguments` carries no security posture of its own, and
 * `backgroundThrottling` is contributed by the reveal-suppression spread
 * (ISS-6112) and is a scheduling hint.
 */
const REVIEWED_NEUTRAL_KEYS = [
  "additionalArguments",
  "backgroundThrottling",
] as const;

/**
 * The ONE expression `preload` may be set to, pinned as source text.
 *
 * `preload` names the file that runs with Node privileges, which under
 * `sandbox: false` makes it as load-bearing as `contextIsolation` itself:
 * repointing it is not a preference change, it is a change of which code holds
 * the privilege. Filing it as reviewed-neutral would leave the single most
 * security-relevant field in the literal unchecked.
 *
 * Pinned as TEXT rather than as a value because the value is only knowable at
 * runtime and this suite cannot boot Electron. That is weaker than the boolean
 * pins — it says "still the reviewed expression", not "still resolves to the
 * reviewed path" — and `resolvePreloadPath`'s own behavior is a separate
 * question this file does not answer. What it does buy is that swapping in a
 * different expression cannot be silent.
 *
 * Checked across EVERY literal the sweep found, not just the constructed one:
 * scoping it to the constructor would leave an `overrideBrowserWindowOptions`
 * added to `window.ts` itself free to name a different privileged script — no
 * new module, no new construction, nothing else in this file reddened.
 */
const REVIEWED_PRELOAD_EXPRESSION = "options.preloadPath";

/** Keys whose INITIALIZER TEXT is pinned rather than their boolean value. */
const TEXT_PINNED_KEYS = ["preload"] as const;

/**
 * The only keys a spread is allowed to contribute.
 *
 * The key policy classifies a key the same way wherever it arrives, which is
 * right for the weakening flags and wrong for the two keys whose safety is a
 * property of WHERE they were written. `preload` is pinned by the exact
 * expression in the constructed literal — a spread that supplies it lands LAST
 * and overrides that pinned expression with something no assertion ever read.
 * So the spread's own output is held to this narrower set: a scheduling hint,
 * and nothing else.
 */
const SPREAD_CONTRIBUTABLE_KEYS: ReadonlySet<string> = new Set([
  "backgroundThrottling",
]);

/**
 * The complete set of keys allowed to reach `webPreferences`, from the literal
 * OR from a spread.
 *
 * This is the "no unexpected weakening key" check. Electron has dozens of
 * `webPreferences` flags and several of them lower the boundary; enumerating
 * only the ones this repo happens to know about would let the next one through
 * silently. So the rule is inverted: an unreviewed key is a failure, and adding
 * one means classifying it into one of the four lists above.
 */
const REVIEWED_WEB_PREFERENCES_KEYS: ReadonlySet<string> = new Set([
  ...MUST_BE_TRUE_KEYS,
  ...MUST_BE_FALSE_KEYS,
  ...MUST_BE_FALSE_IF_PRESENT_KEYS,
  ...MUST_BE_TRUE_IF_PRESENT_KEYS,
  ...TEXT_PINNED_KEYS,
  ...REVIEWED_NEUTRAL_KEYS,
]);

/**
 * Calls whose result may be spread into `webPreferences`, and the module each
 * must be imported from.
 *
 * A spread is an unbounded hole in the key allow-list, so the set of things
 * allowed to open it is kept to helpers whose own output this file drives.
 */
const ALLOWED_WEB_PREFERENCES_SPREADS: ReadonlyMap<string, string> = new Map([
  ["windowRevealSuppressedWebPreferences", "./window-reveal-suppression.js"],
]);

type WebPreferencesLiteral = {
  source: SourceFile;
  literal: ObjectLiteralExpression;
};

let cachedScan: RendererTrustBoundaryScan | undefined;

test("ISS-6710: window.ts constructs exactly one BrowserWindow, with webPreferences", () => {
  const source = parseWindowSource();
  const optionsLiterals = findBrowserWindowOptions(source);

  // A second construction site would be a second renderer trust boundary, and
  // every assertion below reads the first literal it finds — so the count is
  // what makes "the webPreferences" a well-defined thing to guard at all.
  assert.equal(
    optionsLiterals.length,
    1,
    `expected exactly one new BrowserWindow({ ... }) in window.ts; found ${optionsLiterals.length}. A second window is a second trust boundary — guard it here before adding it.`
  );
  // Counted BEFORE the options shape is filtered on. `findBrowserWindowOptions`
  // can only return arguments it can read, so `new BrowserWindow(makeOptions())`
  // contributes nothing to the count above and reads exactly like "there is no
  // second window". Comparing against every construction site makes an
  // unreadable options argument fail here rather than pass unreviewed — this
  // guard must refuse what it cannot inspect, not vouch for it.
  const constructions = countBrowserWindowConstructions(source);
  assert.equal(
    constructions,
    optionsLiterals.length,
    `window.ts constructs ${constructions} BrowserWindow(s) but only ${optionsLiterals.length} pass an inline options literal. This guard reads webPreferences off the literal, so a site whose options come from a variable, a helper call, or a spread cannot be reviewed here — inline them.`
  );
  assert.ok(
    findWebPreferences(optionsLiterals[0]),
    "new BrowserWindow({ ... }) must pass an inline webPreferences object literal; this guard cannot read one assembled elsewhere"
  );
});

test("ISS-6710: window.ts is the only module that opens a renderer trust boundary", () => {
  // The test above pins the ONE construction site this file is pointed at. A
  // second window created in a sibling module — a splash, an onboarding popup, a
  // devtools host — would open a second renderer trust boundary that no suite
  // reads, and every assertion here would stay green. dependency-cruiser cannot
  // express this either: it constrains the import graph, not what a module
  // constructs. So the whole src tree is parsed and asked structurally.
  const scan = sweep();

  // The sweep's own counterfactual, FIRST: everything below reads a list the
  // sweep produced, so a walk that visited nothing — or that quietly stopped
  // visiting one subtree — would satisfy all of it by finding nothing. The
  // floors are written independently of the walk, and per subtree rather than as
  // one total, because a total survives losing whole directories.
  for (const [subtree, floor] of MINIMUM_SWEPT_FILES_BY_SUBTREE) {
    const swept = scan.scannedModules.filter((module) =>
      module.startsWith(`${subtree}${path.sep}`)
    ).length;
    assert.ok(
      swept >= floor,
      `the sweep visited only ${swept} files under src/${subtree} (floor ${floor}). Every assertion in this suite is a statement about what that walk FOUND, so a subtree the walk stopped reaching reports no violations for the same reason a clean one does.`
    );
  }
  const sweptTsx = scan.scannedModules.filter((module) =>
    module.endsWith(".tsx")
  ).length;
  assert.ok(
    sweptTsx >= MINIMUM_SWEPT_TSX_FILES,
    `the sweep visited only ${sweptTsx} .tsx files (floor ${MINIMUM_SWEPT_TSX_FILES}). Narrowing the walk's extension filter drops files from this guard's population without emptying it, which no total-count floor can see.`
  );

  // The floors above are a hand-written enumeration, which makes them complete
  // only for the subtrees that existed when they were written. A NEW top-level
  // directory would be swept but unfloored — so the enumeration answers for its
  // own completeness here, and adding one is a red test rather than a quiet gap.
  assert.deepEqual(
    [
      ...new Set(
        scan.scannedModules.map((module) => module.split(path.sep)[0])
      ),
    ],
    [...MINIMUM_SWEPT_FILES_BY_SUBTREE.keys()],
    "the top-level directories under src no longer match the floors above. Add the new one to MINIMUM_SWEPT_FILES_BY_SUBTREE (or drop the stale entry) — an unfloored subtree is one the sweep can silently stop reaching."
  );

  assert.deepEqual(
    scan.browserWindowModules,
    [RENDERER_TRUST_BOUNDARY_MODULE],
    `a new BrowserWindow appeared outside src/${RENDERER_TRUST_BOUNDARY_MODULE}. Every window carries its own webPreferences, so a second construction site needs its own guard before it ships — this suite only pins one.`
  );

  // The other door, and the reason this is not redundant with the line above:
  // `setWindowOpenHandler` can return `overrideBrowserWindowOptions`, which
  // hands Chromium a webPreferences for a child window that inherits this
  // window's privileged preload — with no `new BrowserWindow` anywhere in the
  // diff. A construction-only sweep is blind to exactly that.
  assert.deepEqual(
    [...new Set(scan.webPreferences.map((found) => found.module))],
    [RENDERER_TRUST_BOUNDARY_MODULE],
    `a webPreferences literal appeared outside src/${RENDERER_TRUST_BOUNDARY_MODULE}. It does not take a new BrowserWindow to hand a renderer different preferences — setWindowOpenHandler's overrideBrowserWindowOptions is enough — so a literal in a sibling module is an unreviewed trust boundary.`
  );
});

test("ISS-6710: contextIsolation is on and no weakening key is set", () => {
  const literals = sweep().webPreferences;
  assert.ok(
    literals.length > 0,
    "no webPreferences object literal found anywhere under src — the sweep reached nothing, so nothing below is being checked"
  );

  // EVERY webPreferences literal in the tree, not only the constructor's: an
  // override literal reached through `setWindowOpenHandler` is the same RCE
  // surface behind a different door.
  const violations = literals.flatMap((found) =>
    [...readPropertyAssignments(found.literal, found.source)].flatMap(
      ([key, value]) => {
        const violation = webPreferenceViolation(found.module, key, value);
        return violation === null ? [] : [violation];
      }
    )
  );
  assert.deepEqual(violations, [], violations.join("\n"));

  // Presence is required only of the CONSTRUCTED window, because a child window
  // opened from it INHERITS the three prefs it cannot loosen: context isolation
  // is always enabled in the opened window if it is enabled on the parent, node
  // integration always disabled if disabled on the parent, and JavaScript the
  // same (https://www.electronjs.org/docs/latest/api/window-open). So an
  // omission in an override literal is safe by inheritance, and demanding the
  // key there would demand a restatement of something Electron already pins.
  //
  // Every OTHER weakening flag — webviewTag, allowRunningInsecureContent,
  // experimentalFeatures, webSecurity, sandbox — is NOT on that inherit list and
  // a child can loosen it. That is why the loop above runs over every literal in
  // the tree rather than this one; only the presence requirement is scoped.
  const constructed = readWebPreferences();
  const assignments = readPropertyAssignments(
    constructed.literal,
    constructed.source
  );
  for (const key of MUST_BE_TRUE_KEYS) {
    assert.equal(
      assignments.get(key),
      true,
      `webPreferences.${key} must be present and literally \`true\` (got ${describeValue(assignments.get(key))}). With sandbox: false the preload runs with Node privileges — lowering this is an RCE surface, not a preference.`
    );
  }
  for (const key of MUST_BE_FALSE_KEYS) {
    assert.equal(
      assignments.get(key),
      false,
      `webPreferences.${key} must be present and literally \`false\` (got ${describeValue(assignments.get(key))}). The preload resolves Electron through createRequire, which a sandboxed preload cannot do, and the contextIsolation message above states a severity that is only true while this is false — so this value is read by other assertions and cannot be left implicit.`
    );
  }
});

test("ISS-6710: exactly one webPreferences names a preload, with the reviewed expression", () => {
  // Scoped to the CONSTRUCTED literal this would be the same asymmetry the rest
  // of the file exists to remove: the boolean keys are policed across every
  // literal in the tree, so policing `preload` on only one of them leaves a
  // second literal — an `overrideBrowserWindowOptions` added to `window.ts`
  // itself, which needs no new module and no new construction — free to name a
  // different privileged script with the whole suite green.
  //
  // One assertion covers presence, uniqueness, location and value, because they
  // are one fact: exactly one script is granted Node privileges here, it is
  // named in the module that owns the trust boundary, and it is the reviewed
  // expression.
  const named = sweep()
    .webPreferences.map((found) => ({
      module: found.module,
      value: topLevelPropertyValueText(found.literal, "preload", found.source),
    }))
    .filter((entry) => entry.value !== undefined)
    .map((entry) => `${entry.module}: ${entry.value}`);

  assert.deepEqual(
    named,
    [`${RENDERER_TRUST_BOUNDARY_MODULE}: ${REVIEWED_PRELOAD_EXPRESSION}`],
    `${named.join("\n")}\nUnder sandbox: false the preload runs with Node privileges, so which file is named is a statement about trust, not configuration. Exactly one webPreferences in the tree may name one, in src/${RENDERER_TRUST_BOUNDARY_MODULE}, and it must be \`${REVIEWED_PRELOAD_EXPRESSION}\`.`
  );
});

test("ISS-6710: only reviewed helpers are spread into webPreferences", () => {
  const spreads = sweep().webPreferences.flatMap((found) =>
    found.literal.properties
      .filter(isSpreadAssignment)
      .map((property) => ({ ...found, property }))
  );

  // Every assertion below lives inside the loop, so an empty `spreads` would
  // pass this test having executed none of them — including the one line tying
  // the helper this suite DRIVES to the helper that actually ships. The expected
  // count is the size of the reviewed-spread map, so the two cannot drift.
  assert.equal(
    spreads.length,
    ALLOWED_WEB_PREFERENCES_SPREADS.size,
    `expected ${ALLOWED_WEB_PREFERENCES_SPREADS.size} spread(s) into webPreferences across the tree; found ${spreads.length}. A spread that disappeared makes every check below vacuous, and one that appeared is an unreviewed hole in the key allow-list.`
  );

  for (const { module, source, property } of spreads) {
    const callee = property.expression;
    assert.ok(
      isCallExpression(callee) && isIdentifier(callee.expression),
      `${module} spreads \`${property.expression.getText(source)}\` into webPreferences, which is not a direct call to a named helper. A spread can contribute ANY key, so the key allow-list in this file only means something while every spread is one this suite also drives.`
    );
    const name = callee.expression.text;
    assert.ok(
      ALLOWED_WEB_PREFERENCES_SPREADS.has(name),
      `${module} spreads \`${name}(...)\` into webPreferences, which is not on the reviewed spread list in this file. Add it here AND assert its output against the same key policy, or inline the keys.`
    );
    // Both halves of the import specifier, because the local name is the half
    // the call site chooses. An ALIASED import binds a different export to the
    // reviewed name — same module, same spelling at the spread, different
    // function — and the behavioral half below would drive the reviewed helper
    // while `window.ts` called the other one.
    assert.deepEqual(
      importedBindingFor(source, name),
      { module: ALLOWED_WEB_PREFERENCES_SPREADS.get(name), exportedName: name },
      `${module} spreads \`${name}(...)\`, but that local name is not the \`${name}\` export of ${ALLOWED_WEB_PREFERENCES_SPREADS.get(name)} — it is bound to a different export, a different module, or nothing this guard can resolve. The behavioral half below drives the reviewed export, so it would be checking a different function than the one that ships.`
    );
  }
});

test("ISS-6710: the spread helper cannot contribute a weakening key", () => {
  // The structural half above proves only WHICH helper is spread. This drives
  // that helper for both of its inputs and puts its real output through the SAME
  // `webPreferenceViolation` the literal goes through — one policy, not two,
  // because the spread is the LAST property of the literal and therefore
  // OVERRIDES it. A second copy of the policy here that happened to omit
  // `contextIsolation` would let the helper turn the lock off with every
  // assertion in this file still green.
  const contributed = [true, false].flatMap((suppressed) =>
    Object.entries(windowRevealSuppressedWebPreferences(suppressed)).map(
      ([key, value]) =>
        ({
          origin: `windowRevealSuppressedWebPreferences(${suppressed})`,
          key,
          value,
        }) as const
    )
  );
  const violations = contributed.flatMap(({ origin, key, value }) => {
    const violation = webPreferenceViolation(
      origin,
      key,
      normalizeValue(value)
    );
    return violation === null ? [] : [violation];
  });
  assert.deepEqual(violations, [], violations.join("\n"));

  // The shared policy is necessary and not sufficient here. It classifies a key
  // the same way wherever it arrives, so a helper that started returning
  // `preload` would pass it — while landing LAST in the literal and overriding
  // the exact expression pinned above with one nothing ever read. A spread's
  // reach is therefore narrower than the literal's.
  const unspreadable = contributed
    .filter(({ key }) => !SPREAD_CONTRIBUTABLE_KEYS.has(key))
    .map(({ origin, key }) => `${origin} contributes webPreferences.${key}`);
  assert.deepEqual(
    unspreadable,
    [],
    `${unspreadable.join("\n")}\nA spread lands last and overrides the literal, so it may only contribute keys whose safety does not depend on the exact expression written in window.ts.`
  );
});

function readWebPreferences(): WebPreferencesLiteral {
  const source = parseWindowSource();
  const [options] = findBrowserWindowOptions(source);
  if (!options) {
    throw new Error("expected a new BrowserWindow({ ... }) call in window.ts");
  }
  const literal = findWebPreferences(options);
  if (!literal) {
    throw new Error("expected new BrowserWindow({ webPreferences: { ... } })");
  }
  return { source, literal };
}

/**
 * The ONE key policy, applied to every key that reaches `webPreferences` — from
 * the object literal in `window.ts` or from a spread's runtime output.
 *
 * Shared deliberately. The spread is the last property of the literal, so it
 * OVERRIDES it; a second copy of this policy for the spread half is exactly how
 * `contextIsolation` gets turned off with the whole suite green.
 *
 * Returns the violation rather than asserting it, so the assertion stays in the
 * test body where a reader can see it (and `noMisplacedAssertion` is satisfied);
 * the callers collect these and assert the collection is empty.
 */
function webPreferenceViolation(
  origin: string,
  key: string,
  value: boolean | "other"
): string | null {
  if (!REVIEWED_WEB_PREFERENCES_KEYS.has(key)) {
    return `${origin} sets webPreferences.${key}, which is not on the reviewed key list in this file. Electron has several flags that lower the renderer trust boundary; classify this one (must-be-true / must-be-false-if-present / reviewed-neutral) before shipping it.`;
  }
  if (
    MUST_BE_TRUE_KEYS.some((required) => required === key) ||
    MUST_BE_TRUE_IF_PRESENT_KEYS.some((required) => required === key)
  ) {
    return value === true
      ? null
      : `${origin} sets webPreferences.${key} to ${describeValue(value)}; this key must be literally \`true\` wherever it is written`;
  }
  if (
    MUST_BE_FALSE_KEYS.some((forbidden) => forbidden === key) ||
    MUST_BE_FALSE_IF_PRESENT_KEYS.some((forbidden) => forbidden === key)
  ) {
    return value === false
      ? null
      : `${origin} sets webPreferences.${key} to ${describeValue(value)}; this key must be literally \`false\` wherever it is written`;
  }
  return null;
}

/**
 * The one structural sweep of `src`, shared by every test in this file.
 *
 * Memoized because the walk parses the whole desktop source tree (~12s) and the
 * three tests below ask it three different questions about the SAME tree. It is
 * a pure read of files that do not change during a run, so one walk is not a
 * shortcut — three would be the same answer, three times slower.
 */
function sweep(): RendererTrustBoundaryScan {
  cachedScan ??= scanDesktopSourceForRendererTrustBoundary();
  return cachedScan;
}

/**
 * The `key -> boolean-or-other` map for the literal's own properties.
 *
 * Values are normalized to the same shape a runtime object yields so the literal
 * and the spread can share one policy. `"other"` means "written, but not a
 * boolean literal" — a distinct state from absent (which is a missing map entry)
 * and never silently treated as safe.
 *
 * Anything that is not a plain `key: value` assignment — a shorthand, a method,
 * an accessor, a computed key — is rejected rather than skipped: each of those
 * spellings can set one of these flags in a way the check would never see, so
 * silently ignoring them is how the guard would go green on the exact mutation
 * it exists to catch.
 */
function readPropertyAssignments(
  literal: ObjectLiteralExpression,
  source: SourceFile
): Map<string, boolean | "other"> {
  const assignments = new Map<string, boolean | "other">();
  for (const property of literal.properties) {
    if (isSpreadAssignment(property)) {
      continue;
    }
    if (!(isPropertyAssignment(property) && isIdentifier(property.name))) {
      throw new Error(
        `webPreferences contains \`${property.getText(source)}\`, which is not a plain \`key: value\` property. This guard reads initializers structurally and cannot classify that spelling.`
      );
    }
    assignments.set(
      property.name.text,
      normalizeKind(property.initializer.kind)
    );
  }
  return assignments;
}

function normalizeKind(kind: SyntaxKind): boolean | "other" {
  if (kind === SyntaxKind.TrueKeyword) {
    return true;
  }
  if (kind === SyntaxKind.FalseKeyword) {
    return false;
  }
  return "other";
}

/**
 * The runtime counterpart of {@link normalizeKind}.
 *
 * Anything that is not exactly `true` or `false` — including the `undefined` an
 * explicitly-present optional key yields — is `"other"`, which fails any key the
 * policy pins rather than passing as "close enough".
 */
function normalizeValue(value: unknown): boolean | "other" {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  return "other";
}

/**
 * The module a source imports the local name `name` from, AND the export that
 * actually produced that binding.
 *
 * The exported name is not bookkeeping. An import specifier has two halves, and
 * matching only the local one — `element.name`, which is what the call site
 * SPELLS — proves the spread is spelled right, never that it is the reviewed
 * helper. `import { unsafePrefs as windowRevealSuppressedWebPreferences }` from
 * this very module satisfies both the local name and the module specifier while
 * the shipping call reaches a function this suite never drives; the behavioral
 * half then puts the reviewed helper through the key policy and reports green
 * over a spread that can contribute anything. So the ORIGINAL export name is
 * carried out of here and asserted too.
 *
 * `propertyName` is present only when the import is aliased, so an unaliased
 * `import { helper }` reports `helper` as both halves.
 */
function importedBindingFor(
  source: SourceFile,
  name: string
): { module: string; exportedName: string } | undefined {
  for (const statement of source.statements) {
    if (!(isImportDeclaration(statement) && statement.importClause)) {
      continue;
    }
    const bindings = statement.importClause.namedBindings;
    if (!(bindings && isNamedImports(bindings))) {
      continue;
    }
    const specifier = bindings.elements.find(
      (element) => element.name.text === name
    );
    if (specifier && isStringLiteral(statement.moduleSpecifier)) {
      return {
        module: statement.moduleSpecifier.text,
        exportedName: specifier.propertyName?.text ?? specifier.name.text,
      };
    }
  }
  return undefined;
}

function describeValue(value: boolean | "other" | undefined): string {
  if (value === undefined) {
    return "absent";
  }
  return value === "other" ? "a non-boolean expression" : String(value);
}
