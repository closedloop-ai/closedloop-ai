/**
 * Drift guard (ISS-6851) for the `eventsTruncated` completeness contract.
 *
 * `apps/web/content/docs/api-reference/openapi.json` hand-copies, in prose, the
 * meaning of `AgentSessionDetail.eventsTruncated`, whose SSOT is the JSDoc on
 * that property in `@repo/api`'s `types/agent-session.ts`. The two drifted: the
 * spec still told clients that ABSENCE was the only encoding of "complete"
 * after ISS-5636 (#5150) narrowed the type's own reading to a ONE-WAY
 * implication — set means prefix, absent does NOT mean whole-run, because the
 * trace SOURCE arrays carry `SESSION_TRACE_SOURCE_LIMITS` caps this flag
 * neither observes nor reports. A client generated from the stale spec would
 * present a capped `phaseIterations` as the whole run, which is exactly the
 * false-completeness the flag exists to remove.
 *
 * Nothing else compares the two. Lint and typecheck only prove the spec parses,
 * and the sibling vocabulary guards next door compare `enum`s — this contract
 * has no enum to compare, because it is a SEMANTIC claim carried entirely in
 * prose on both sides.
 *
 * So the comparison is between the two TEXTS, and the durable, wording-
 * independent part of both is the SET OF FIELD NAMES the narrowing covers.
 * {@link ssotNarrowedFieldNames} reads them off the SSOT's ISS-5636 paragraph
 * and {@link specNarrowedFieldNames} off the spec's matching clause; adding a
 * capped projection to one side without the other reds here. That is the drift
 * that matters. The comparison is over NAMES, not wording, so reflowing or
 * rewording either sentence is free — but a name entering either extraction
 * window, for any reason, reds until the other side names it too. That
 * strictness is the point, not a rough edge: it is what stops a newly capped
 * projection from being documented on one side alone.
 *
 * The SSOT side is read through `ts.createSourceFile` and the JSDoc AST, not as
 * raw source text — the mechanism AGENTS.md → "Test Practices" prescribes and
 * `scripts/lint/rules/no-raw-text-source-scan.ts` enforces. A JSDoc comment is
 * the one thing a source-shape guard can legitimately assert on here, because
 * the published contract IS documentation: there is no runtime value to hold
 * the spec against.
 *
 * Sets, not sequences: the two texts list the fields in different orders and
 * the SSOT names `phaseIterations` twice (once in the list, once in the worked
 * example). Sorted unique values catch every add/remove/rename without failing
 * on a reordering — and unlike the status-vocabulary guard next door, a widened
 * extraction window here cannot pass silently, since the extra names it swept
 * up are absent from the other side and fail the equality.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const openApiPath = path.join(
  repoRoot,
  "apps/web/content/docs/api-reference/openapi.json"
);
const ssotPath = path.join(repoRoot, "packages/api/src/types/agent-session.ts");

type PropertySchema = { type?: string; enum?: unknown[]; description?: string };
type OpenApiDoc = {
  components: {
    schemas: Record<
      string,
      {
        allOf?: {
          required?: string[];
          properties?: Record<string, PropertySchema>;
        }[];
      }
    >;
  };
};

const openApi = JSON.parse(readFileSync(openApiPath, "utf8")) as OpenApiDoc;

/** The `AgentSessionDetail` branch that declares the detail-only extensions. */
function detailExtensions() {
  const branches = openApi.components.schemas.AgentSessionDetail.allOf ?? [];
  const branch = branches.find((entry) => entry.properties?.eventsTruncated);
  if (!branch) {
    throw new Error(
      "openapi.json no longer documents AgentSessionDetail.eventsTruncated"
    );
  }
  return branch;
}

const specDescription =
  detailExtensions().properties?.eventsTruncated?.description ?? "";

/** Each backticked run in a sentence. */
const BACKTICKED_VALUE = /`([^`]+)`/g;

/**
 * A backticked run that reads as a wire field name.
 *
 * Drops the SSOT's `SESSION_TRACE_SOURCE_LIMITS` — the cap constant, not a
 * served field — and every other SCREAMING_CASE or PascalCase symbol either text
 * may name.
 */
const WIRE_FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;

/**
 * Backticked runs that pass {@link WIRE_FIELD_NAME} but name the ENCODING
 * rather than a field. Both texts describe the `true`-or-absent wire shape
 * within a sentence of the narrowed list, so leaving these in would let a
 * sentence about the encoding move a set that is supposed to be about caps.
 */
const ENCODING_LITERALS: ReadonlySet<string> = new Set(["true", "false"]);

/** Each backticked identifier in `text` that reads as a wire field name. */
function backtickedFieldNames(text: string): string[] {
  const names = [...text.matchAll(BACKTICKED_VALUE)]
    .map((match) => match[1])
    .filter(
      (name) => WIRE_FIELD_NAME.test(name) && !ENCODING_LITERALS.has(name)
    );
  return [...new Set(names)].sort();
}

/**
 * The fields the SSOT's ISS-5636 paragraph says this flag does NOT describe.
 *
 * Paragraph-scoped on purpose. The JSDoc's other paragraphs name a DIFFERENT
 * set for a different reason — ISS-5407 lists the widened desktop scope the
 * flag DOES cover, and the closing paragraph names `toolUseCount` and friends
 * precisely to say they are excluded from it — so a whole-comment sweep would
 * assert the wrong set.
 */
function ssotNarrowedFieldNames(): string[] {
  const sourceFile = ts.createSourceFile(
    ssotPath,
    readFileSync(ssotPath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const clause = ssotEventsTruncatedDoc(sourceFile)
    .split(PARAGRAPH_BREAK)
    .find((paragraph) => paragraph.startsWith(SSOT_NARROWING_MARKER));
  return backtickedFieldNames(clause ?? "");
}

/** The paragraph marker ISS-5636 left on the clause that narrowed the flag. */
const SSOT_NARROWING_MARKER = "ISS-5636:";

/** A blank line in the rendered JSDoc text. */
const PARAGRAPH_BREAK = /\n\s*\n/;

/** The JSDoc text on `AgentSessionDetail.eventsTruncated`, via the AST. */
function ssotEventsTruncatedDoc(sourceFile: ts.SourceFile): string {
  const alias = sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "AgentSessionDetail"
  );
  if (!alias) {
    throw new Error("AgentSessionDetail is no longer a type alias in the SSOT");
  }

  let property: ts.PropertySignature | undefined;
  const visit = (node: ts.Node): void => {
    if (property) {
      return;
    }
    if (
      ts.isPropertySignature(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "eventsTruncated"
    ) {
      property = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(alias);
  if (!property) {
    throw new Error("AgentSessionDetail no longer declares eventsTruncated");
  }

  const doc = ts.getJSDocCommentsAndTags(property).find(ts.isJSDoc);
  return ts.getTextOfJSDocComment(doc?.comment) ?? "";
}

/**
 * The fields the spec's narrowing clause publishes as not-described-by-the-flag.
 *
 * Delimited by the em dashes the sentence supplies, the same way the
 * status-vocabulary guard next door scopes its advertised list: the sentences
 * around it name `events` and `phaseIterations` for other reasons, so an
 * unscoped sweep of the description would assert a different set than the SSOT
 * clause does and fail on wording rather than on drift.
 */
const SPEC_NARROWING_SENTENCE = /neither observes nor reports — ([^—]+) —/;

/**
 * The claim ISS-5636 retracted, in the spelling the spec carried until now.
 *
 * Banned in the SPEC only, and deliberately so: the SSOT still carries the same
 * words in its ISS-5075 paragraph, where they are correct — that sentence is
 * about the `events` relation and producer compatibility, and the ISS-5636
 * paragraph two below narrows it inside the same comment. A generated client
 * reads one field's description with no such structure around it, so the spec
 * has to carry the narrowed claim outright. Re-deriving the description from the
 * SSOT top-down would copy the ISS-5075 sentence back, which is precisely the
 * drift this assertion catches on the next run.
 */
const RETRACTED_WHOLE_RUN_CLAIM = /only encoding of/i;

/** The narrowed reading that replaced it, in the SSOT's own words. */
const ONE_WAY_IMPLICATION = /not thereby whole-run/;

function specNarrowedFieldNames(): string[] {
  return backtickedFieldNames(
    SPEC_NARROWING_SENTENCE.exec(specDescription)?.[1] ?? ""
  );
}

describe("openapi.json eventsTruncated completeness contract (ISS-6851)", () => {
  it("publishes the same narrowed field set the SSOT's ISS-5636 clause names", () => {
    const ssot = ssotNarrowedFieldNames();

    // A SSOT rewrite that dropped the ISS-5636 paragraph, or a spec rewrite
    // that dropped the clause, must fail here rather than pass vacuously on an
    // empty-vs-empty comparison.
    expect(ssot).not.toHaveLength(0);
    expect(specNarrowedFieldNames()).toEqual(ssot);
  });

  it("states the one-way implication rather than asserting absence means whole-run", () => {
    // The retracted claim is pinned as an ABSENCE because it is the specific
    // sentence a client acted on: it told a generated client that a missing
    // flag encoded a complete trace.
    expect(specDescription).not.toMatch(RETRACTED_WHOLE_RUN_CLAIM);
    expect(specDescription).toMatch(ONE_WAY_IMPLICATION);
  });

  it("keeps the true-or-absent wire encoding the SSOT relies on", () => {
    // The half of the old sentence that stayed true, and the reason absence has
    // to carry a narrowed meaning rather than a stronger one: there is no
    // serialized `false` to distinguish "complete" from "not reported". Typing
    // it as a plain optional boolean would make one, so this is pinned even
    // though no code change proposed it.
    const branch = detailExtensions();
    const schema = branch.properties?.eventsTruncated;

    expect({ type: schema?.type, enum: schema?.enum }).toEqual({
      type: "boolean",
      enum: [true],
    });
    expect(branch.required ?? []).not.toContain("eventsTruncated");
  });
});
