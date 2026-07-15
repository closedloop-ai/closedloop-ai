import axe from "axe-core";

export type AxeAllowlistEntry = {
  id: string;
  target: string;
  reason: string;
};

const CRITICAL_IMPACT = "critical";
export const WCAG_AA_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
] as const;

export async function expectCriticalAxeClean(
  container: Element,
  allowlist: AxeAllowlistEntry[] = []
) {
  const results = await axe.run(container, {
    resultTypes: ["violations"],
    runOnly: {
      type: "tag",
      values: [...WCAG_AA_TAGS],
    },
  });
  const violations = results.violations
    .filter((violation) => violation.impact === CRITICAL_IMPACT)
    .flatMap((violation) =>
      violation.nodes.map((node) => ({
        id: violation.id,
        impact: violation.impact,
        target: node.target.join(" "),
      }))
    )
    .filter((violation) => !isAllowed(violation, allowlist));

  if (violations.length > 0) {
    throw new Error(
      `Critical axe violations: ${JSON.stringify(violations, null, 2)}`
    );
  }
}

function isAllowed(
  violation: { id: string; target: string },
  allowlist: AxeAllowlistEntry[]
): boolean {
  return allowlist.some(
    (entry) =>
      entry.id === violation.id &&
      entry.target === violation.target &&
      entry.reason.trim().length > 0
  );
}
