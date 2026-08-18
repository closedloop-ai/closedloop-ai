import { readFileSync } from "node:fs";
import path from "node:path";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeBranchDetail as detail } from "../../__tests__/branch-fixtures";
import { BranchCostToMerge } from "../branch-cost-to-merge";

/**
 * The approved Branch Details prototype renders `.bq-sec-title` as a real
 * foreground heading while `.bq-sec-count` remains a subordinate muted count.
 * Neither is the uppercase eyebrow reserved for metric-card labels.
 *
 * This loads the ENTIRE shipped `branch-detail.css` (the production stylesheet
 * that owns these rules) into the document, renders the real component, and
 * asserts the *computed* treatment on the rendered elements through the full
 * cascade — never a regex over one rule's source text. A later override anywhere
 * in the file therefore participates in the cascade and would be caught, and the
 * assertions survive renames/reorders of the rule.
 *
 * jsdom's getComputedStyle does NOT substitute `var(--…)` — it echoes the raw
 * custom-property reference — so the contract is asserted two ways that don't
 * depend on resolution: literal keyword declarations (`text-transform`,
 * `font-weight`) that jsdom does resolve, plus the exact prototype token
 * references for the title and subordinate count.
 */
const BRANCH_DETAIL_CSS = path.resolve(
  import.meta.dirname,
  "../../branch-detail.css"
);

// `@import` / `@source` at-rules are meaningless inside an injected <style>;
// strip them so only the concrete rules participate in the cascade.
const AT_RULE_RE = /^\s*@(?:import|source)[^;]*;/gm;

// The eyebrow's muted color token; the heading must NOT resolve to it. jsdom
// echoes the raw `var(--…)` reference for `color`, so we compare against the
// token string the old eyebrow rule used.
const MUTED_FOREGROUND_VAR = "var(--muted-foreground)";

function loadBranchDetailCss(): string {
  return readFileSync(BRANCH_DETAIL_CSS, "utf8").replace(AT_RULE_RE, "");
}

function injectBranchDetailStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = loadBranchDetailCss();
  document.head.appendChild(style);
  return style;
}

function renderHead() {
  const { container } = render(
    <BranchCostToMerge detail={detail({ estimatedCostUsd: 1.5 })} />
  );
  return {
    title: container.querySelector(".bq-sec-title"),
    count: container.querySelector(".bq-sec-count"),
  };
}

describe("branch-detail section head (.bq-sec-title / .bq-sec-count, FEA-4234)", () => {
  let styleEl: HTMLStyleElement | null = null;

  afterEach(() => {
    styleEl?.remove();
    styleEl = null;
  });

  it("renders the section title as a real heading (semibold, normal case), not the muted uppercase eyebrow", () => {
    styleEl = injectBranchDetailStyles();
    const { title } = renderHead();
    expect(title).not.toBeNull();
    const computed = getComputedStyle(title as Element);
    expect(computed.fontWeight).toBe("600");
    // The old eyebrow was `text-transform: uppercase`; a heading is normal case.
    expect(computed.textTransform).not.toBe("uppercase");
    // The eyebrow read `--muted-foreground`; the heading reads foreground.
    expect(computed.color).not.toBe(MUTED_FOREGROUND_VAR);
  });

  it("renders the section total with the prototype's subordinate count treatment", () => {
    styleEl = injectBranchDetailStyles();
    const { title, count } = renderHead();
    expect(title).not.toBeNull();
    expect(count).not.toBeNull();
    const titleStyle = getComputedStyle(title as Element);
    const countStyle = getComputedStyle(count as Element);
    expect(titleStyle.color).not.toBe(MUTED_FOREGROUND_VAR);
    expect(countStyle.color).toBe(MUTED_FOREGROUND_VAR);
    expect(countStyle.fontSize).toBe("var(--text-xs)");
  });
});
