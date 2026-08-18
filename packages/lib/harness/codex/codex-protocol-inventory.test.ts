import { describe, expect, it } from "vitest";
import {
  CODEX_PARSER_COVERAGE,
  CODEX_PROTOCOL_CATEGORIES,
  CODEX_PROTOCOL_INVENTORY,
  CODEX_PROTOCOL_SUPPORT,
  type CodexParserCoverage,
  type CodexProtocolCategory,
  type CodexProtocolInventory,
  diffInventoryAgainstCoverage,
} from "./codex-protocol-inventory";
import {
  CODEX_DECODED_EVENT_MSG_TYPES,
  CODEX_DECODED_RESPONSE_ITEM_TYPES,
  classify,
} from "./parse-codex";

// FEA-3715 (Parser roadmap 9): prove the drift detector keeps the reviewed
// protocol inventory, the parser coverage map, and the LIVE handler registries
// in lockstep — the mechanism that turns silent upstream-Codex drift into a CI
// failure. No test here fetches upstream source: the inventory is a checked-in
// pin (acceptance criterion 4).

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Deep, mutable clone of the frozen inventory so a fixture can perturb it. */
function cloneInventory(): CodexProtocolInventory {
  return JSON.parse(
    JSON.stringify(CODEX_PROTOCOL_INVENTORY)
  ) as CodexProtocolInventory;
}

describe("CODEX_PROTOCOL_SUPPORT pin", () => {
  it("records the reviewed upstream commit as the supported-range anchor", () => {
    expect(CODEX_PROTOCOL_SUPPORT.referenceRepo).toBe("steipete/CodexBar");
    expect(CODEX_PROTOCOL_SUPPORT.pinnedCommit).toBe(
      "963cda85aa2a4cfb85e52d771d22d9f3069951fa"
    );
    expect(CODEX_PROTOCOL_SUPPORT.reviewedOn).toMatch(ISO_DATE_RE);
    expect(CODEX_PROTOCOL_SUPPORT.supportedRange.length).toBeGreaterThan(0);
  });
});

describe("inventory ↔ coverage are in sync (CI drift gate)", () => {
  it("reports zero drift for the checked-in pin", () => {
    expect(
      diffInventoryAgainstCoverage(
        CODEX_PROTOCOL_INVENTORY,
        CODEX_PARSER_COVERAGE
      )
    ).toEqual([]);
  });

  it("covers every category on both sides", () => {
    for (const category of CODEX_PROTOCOL_CATEGORIES) {
      expect(CODEX_PROTOCOL_INVENTORY[category]).toBeDefined();
      expect(CODEX_PARSER_COVERAGE[category]).toBeDefined();
    }
  });

  it("has no duplicate variant names within a category", () => {
    for (const category of CODEX_PROTOCOL_CATEGORIES) {
      const inventoryNames = CODEX_PROTOCOL_INVENTORY[category].map(
        (e) => e.name
      );
      const coverageNames = CODEX_PARSER_COVERAGE[category].map((e) => e.name);
      expect(new Set(inventoryNames).size).toBe(inventoryNames.length);
      expect(new Set(coverageNames).size).toBe(coverageNames.length);
    }
  });
});

describe("coverage map proves a disposition for every variant (R2)", () => {
  it("assigns a valid disposition, with a rationale for ignored/opaque", () => {
    for (const category of CODEX_PROTOCOL_CATEGORIES) {
      for (const entry of CODEX_PARSER_COVERAGE[category]) {
        expect(["decoded", "ignored", "opaque"]).toContain(entry.disposition);
        if (entry.disposition === "ignored" || entry.disposition === "opaque") {
          expect(entry.rationale?.trim().length ?? 0).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps decoded event_msg coverage in lockstep with the live EVENT_HANDLERS", () => {
    const decoded = CODEX_PARSER_COVERAGE.event_msg
      .filter((e) => e.disposition === "decoded")
      .map((e) => e.name);
    expect(new Set(decoded)).toEqual(new Set(CODEX_DECODED_EVENT_MSG_TYPES));
  });

  it("keeps decoded response_item coverage in lockstep with RESPONSE_ITEM_HANDLERS", () => {
    const decoded = CODEX_PARSER_COVERAGE.response_item
      .filter((e) => e.disposition === "decoded")
      .map((e) => e.name);
    expect(new Set(decoded)).toEqual(
      new Set(CODEX_DECODED_RESPONSE_ITEM_TYPES)
    );
  });

  it("never marks an inventoried event_msg decoded without a live handler", () => {
    const handlers = new Set(CODEX_DECODED_EVENT_MSG_TYPES);
    for (const entry of CODEX_PARSER_COVERAGE.event_msg) {
      if (entry.disposition === "decoded") {
        expect(handlers.has(entry.name)).toBe(true);
      } else {
        // Ignored/opaque variants must NOT have a live handler — otherwise the
        // "explicitly not decoded" claim is a lie.
        expect(handlers.has(entry.name)).toBe(false);
      }
    }
  });
});

describe("declared rollout_item aliases are recognized by classify()", () => {
  const aliasToKind: Record<string, string> = {
    "session.created": "session_meta",
    "turn.context": "turn_context",
    event: "event",
    "response.item": "response_item",
  };

  for (const entry of CODEX_PROTOCOL_INVENTORY.rollout_item) {
    for (const alias of entry.aliases ?? []) {
      it(`classifies "${alias}" as the ${entry.name} kind`, () => {
        const classified = classify({ type: alias, payload: {} });
        expect(classified?.kind).toBe(aliasToKind[alias]);
      });
    }
  }
});

describe("drift fixtures simulate upstream changes (R1)", () => {
  const category: CodexProtocolCategory = "event_msg";

  it("flags an ADDED upstream variant as an unreviewed addition", () => {
    const mutated = cloneInventory();
    mutated[category] = [
      ...mutated[category],
      { name: "web_search_call_begin" },
    ];
    const drift = diffInventoryAgainstCoverage(mutated, CODEX_PARSER_COVERAGE);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      kind: "unreviewed_addition",
      category,
      name: "web_search_call_begin",
    });
  });

  it("flags a REMOVED upstream variant as stale coverage", () => {
    const mutated = cloneInventory();
    mutated[category] = mutated[category].filter(
      (e) => e.name !== "token_count"
    );
    const drift = diffInventoryAgainstCoverage(mutated, CODEX_PARSER_COVERAGE);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      kind: "stale_coverage",
      category,
      name: "token_count",
    });
  });

  it("flags a RENAMED variant as one removal plus one addition", () => {
    const mutated = cloneInventory();
    mutated[category] = mutated[category].map((e) =>
      e.name === "agent_message" ? { ...e, name: "assistant_message" } : e
    );
    const drift = diffInventoryAgainstCoverage(mutated, CODEX_PARSER_COVERAGE);
    expect(drift).toHaveLength(2);
    expect(drift.map((d) => d.kind).sort()).toEqual([
      "stale_coverage",
      "unreviewed_addition",
    ]);
    expect(drift.map((d) => d.name).sort()).toEqual([
      "agent_message",
      "assistant_message",
    ]);
  });

  it("flags an ALIASED variant as an alias change", () => {
    const mutated = cloneInventory();
    mutated.rollout_item = mutated.rollout_item.map((e) =>
      e.name === "session_meta"
        ? { ...e, aliases: ["session.created", "session.started"] }
        : e
    );
    const drift = diffInventoryAgainstCoverage(mutated, CODEX_PARSER_COVERAGE);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      kind: "alias_change",
      category: "rollout_item",
      name: "session_meta",
    });
  });

  it("detects a DROPPED alias as an alias change too", () => {
    const mutated = cloneInventory();
    mutated.rollout_item = mutated.rollout_item.map((e) =>
      e.name === "event_msg" ? { ...e, aliases: [] } : e
    );
    const drift = diffInventoryAgainstCoverage(mutated, CODEX_PARSER_COVERAGE);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ kind: "alias_change", name: "event_msg" });
  });

  it("detects an alias change when same-size alias sets have different contents", () => {
    // The aliasesDiffer inner loop (same sa.size === sb.size, but !sb.has(value))
    // was previously only reachable when sa.size !== sb.size; this test ensures
    // the loop body fires when one alias is swapped for another.
    const inv: CodexProtocolInventory = {
      rollout_item: [{ name: "event_a", aliases: ["alias-x"] }],
      response_item: [],
      content: [],
      session_meta: [],
      turn_context: [],
      event_msg: [],
    };
    const cov: CodexParserCoverage = {
      rollout_item: [
        { name: "event_a", disposition: "decoded", aliases: ["alias-y"] },
      ],
      response_item: [],
      content: [],
      session_meta: [],
      turn_context: [],
      event_msg: [],
    };
    const drift = diffInventoryAgainstCoverage(inv, cov);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ kind: "alias_change", name: "event_a" });
  });

  it("treats a missing inventory category key as empty via the ?? [] fallback", () => {
    // Exercises inventory[category] ?? [] when a category key is absent at runtime.
    const incompleteInv = {
      response_item: CODEX_PROTOCOL_INVENTORY.response_item,
      content: CODEX_PROTOCOL_INVENTORY.content,
      session_meta: CODEX_PROTOCOL_INVENTORY.session_meta,
      turn_context: CODEX_PROTOCOL_INVENTORY.turn_context,
      event_msg: CODEX_PROTOCOL_INVENTORY.event_msg,
      // rollout_item intentionally absent
    } as CodexProtocolInventory;
    // All inventory entries for rollout_item are absent → each becomes stale_coverage.
    const drift = diffInventoryAgainstCoverage(
      incompleteInv,
      CODEX_PARSER_COVERAGE
    );
    const staleCoverage = drift.filter(
      (d) => d.kind === "stale_coverage" && d.category === "rollout_item"
    );
    expect(staleCoverage.length).toBeGreaterThan(0);
  });

  it("treats a missing coverage category key as empty via the ?? [] fallback", () => {
    // Exercises coverage[category] ?? [] when a category key is absent at runtime.
    const incompleteCov = {
      response_item: CODEX_PARSER_COVERAGE.response_item,
      content: CODEX_PARSER_COVERAGE.content,
      session_meta: CODEX_PARSER_COVERAGE.session_meta,
      turn_context: CODEX_PARSER_COVERAGE.turn_context,
      event_msg: CODEX_PARSER_COVERAGE.event_msg,
      // rollout_item intentionally absent
    } as CodexParserCoverage;
    // All inventory entries for rollout_item have no coverage → unreviewed_addition.
    const drift = diffInventoryAgainstCoverage(
      CODEX_PROTOCOL_INVENTORY,
      incompleteCov
    );
    const unreviewed = drift.filter(
      (d) => d.kind === "unreviewed_addition" && d.category === "rollout_item"
    );
    expect(unreviewed.length).toBeGreaterThan(0);
  });
});
