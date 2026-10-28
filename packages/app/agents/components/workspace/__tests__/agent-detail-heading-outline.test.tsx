import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { agentDetailSource, makeDetail } from "../agent-component-fixtures";
import { AgentDetail } from "../agent-detail";

/**
 * ISS-5540 item 6. The Agent detail page went `h1` straight to `h3`: the
 * component name, then `Definition` / `Invocations` (and, on web, `Usage over
 * time`) with no `h2` between them. A screen-reader user navigating by heading
 * reads a skipped level as a missing section and loses the relationship between
 * the page and the sections under it. WCAG 2.2 SC 1.3.1 Info and Relationships
 * (Level A).
 *
 * This asserts the OUTLINE — the ordered levels — rather than counting `h2`s,
 * because a count is satisfied by a page whose headings are in the wrong order
 * and by a page that renders none at all.
 *
 * The detail component is shared: `apps/app` and the Electron renderer both
 * mount THIS component, including Usage over time, so this file covers the
 * outline on both surfaces.
 */

describe("AgentDetail heading outline", () => {
  it("renders a single h1 named for the component, with its sections one level under it", async () => {
    const detail = makeDetail();
    render(
      <Wrapper dataSource={agentDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );
    // Wait for the LOADED state by name. The loading branch owns its own
    // sr-only `h1` ("Agent"), so a bare level-1 wait resolves on the skeleton
    // and the outline below would be asserted against a page with one heading.
    await screen.findByRole("heading", { level: 1, name: detail.name });

    expect(await readOutline()).toEqual([
      { level: 1, name: detail.name },
      { level: 2, name: "Definition" },
      { level: 2, name: "Usage over time" },
      { level: 2, name: "Invocations" },
    ]);
  });

  it("never skips a heading level", async () => {
    const detail = makeDetail();
    render(
      <Wrapper dataSource={agentDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );
    await screen.findByRole("heading", { level: 1, name: detail.name });

    // The invariant, stated separately from the exact outline above so a future
    // section added in the right place keeps this green and a section added at
    // the wrong level does not.
    const levels = (await readOutline()).map((heading) => heading.level);
    expect(levels[0]).toBe(1);
    for (const [index, level] of levels.slice(1).entries()) {
      expect(level - levels[index]).toBeLessThanOrEqual(1);
    }
  });

  // The h1 is page chrome above the shared shell (operator ruling 2026-10-20,
  // mirroring Branch detail), so leaving the Artifact tab must not drop it.
  it.each(["Details", "Sessions"])(
    "keeps the component-name h1 on the %s tab",
    async (tab) => {
      const detail = makeDetail();
      render(
        <Wrapper dataSource={agentDetailSource(detail)}>
          <AgentDetail backHref="/acme/agents" slug={detail.id} />
        </Wrapper>
      );
      await screen.findByRole("heading", { level: 1, name: detail.name });

      // The shell's own strip: the Invocations strip also has a Sessions tab.
      const sections = within(
        screen.getByRole("tablist", { name: "Artifact detail sections" })
      );
      await userEvent.click(sections.getByRole("tab", { name: tab }));
      expect(
        await sections.findByRole("tab", { name: tab, selected: true })
      ).toBeTruthy();
      expect(
        screen.queryByRole("heading", { level: 2, name: "Definition" })
      ).toBeNull();

      expect(
        screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)
      ).toEqual([detail.name]);
    }
  );
});

/**
 * Every heading in the rendered page, in document order, with the level a
 * screen reader would announce.
 *
 * `aria-level` wins over the tag when both are present, which is what makes
 * this read the ACCESSIBILITY tree's outline rather than the markup's.
 */
async function readOutline(): Promise<
  { level: number; name: string | null }[]
> {
  const headings = await screen.findAllByRole("heading");
  return headings.map((heading) => ({
    level: Number(
      heading.getAttribute("aria-level") ?? heading.tagName.slice(1)
    ),
    name: heading.textContent,
  }));
}

function Wrapper({
  children,
  dataSource,
}: {
  children: ReactNode;
  dataSource: AgentComponentsDataSource;
}) {
  return (
    <AppCoreStoryProviders>
      <AgentComponentsDataSourceProvider dataSource={dataSource}>
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}
