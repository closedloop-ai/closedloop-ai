import { expect, type Page } from "@playwright/test";
import { WCAG_AA_TAGS } from "../../packages/app/test/a11y/axe";

type WcagAaOptions = {
  criticalOnly?: boolean;
  scope?: string;
};

/**
 * Runs the shared WCAG 2.0-2.2 A/AA axe rules against an authenticated page.
 *
 * The caller resolves and reads axe-core from the runtime it is validating so
 * this browser helper never silently selects a different package instance.
 */
export async function expectWcagAaClean(
  page: Page,
  axeSource: string,
  options: WcagAaOptions = {}
): Promise<void> {
  await page.evaluate((source) => {
    Function(source)();
  }, axeSource);

  const violations = await page.evaluate(
    async ({ tags, options: runOptions }) => {
      const axe = Reflect.get(globalThis, "axe") as AxeRuntime;
      const results = await axe.run(runOptions.scope ?? document, {
        resultTypes: ["violations"],
        runOnly: {
          type: "tag",
          values: [...tags],
        },
      });
      return results.violations
        .filter(
          (violation) =>
            !runOptions.criticalOnly || violation.impact === "critical"
        )
        .flatMap((violation) =>
          violation.nodes.map((node) => ({
            id: violation.id,
            impact: violation.impact,
            target: node.target.join(" "),
          }))
        );
    },
    { options, tags: WCAG_AA_TAGS }
  );

  expect(violations).toEqual([]);
}

type AxeViolation = {
  id: string;
  impact: string | null;
  nodes: Array<{ target: string[] }>;
};

type AxeRuntime = {
  run: (
    context: Document | string,
    options: {
      resultTypes: string[];
      runOnly: { type: "tag"; values: string[] };
    }
  ) => Promise<{ violations: AxeViolation[] }>;
};
