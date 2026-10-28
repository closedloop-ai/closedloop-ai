import { expect, type Page } from "@playwright/test";
import { WCAG_AA_TAGS } from "../../packages/app/test/a11y/axe";

type WcagAaOptions = {
  criticalOnly?: boolean;
  /** Selectors inside `scope` that the rules skip, with their subtrees. */
  exclude?: readonly string[];
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
      const context = {
        exclude: [...(runOptions.exclude ?? [])],
        include: runOptions.scope ?? document,
      };
      const axeOptions = {
        resultTypes: ["violations"],
        runOnly: {
          type: "tag" as const,
          values: [...tags],
        },
      };
      let results: { violations: AxeViolation[] } | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          results = await axe.run(context, axeOptions);
          break;
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              error.message.includes("Axe is already running")
            ) ||
            attempt === 49
          ) {
            throw error;
          }
          await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
        }
      }
      if (!results) {
        throw new Error("Concurrent axe scan did not finish");
      }
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
    context: { exclude: string[]; include: Document | string },
    options: {
      resultTypes: string[];
      runOnly: { type: "tag"; values: string[] };
    }
  ) => Promise<{ violations: AxeViolation[] }>;
};
