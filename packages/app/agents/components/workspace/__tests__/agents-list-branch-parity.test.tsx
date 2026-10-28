import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { makeComponent } from "../agent-component-fixtures";
import { AgentsGroupedList } from "../agents-grouped-list";
import { AgentsListSurfaceV2 } from "../agents-list-surface-v2";
import { testDataSource, Wrapper } from "./agents-grouped-list-harness";

/**
 * ISS-9398 — the two branches of `agent-ops-complete-surface` render the same
 * Agents inventory.
 *
 * This is what the registry's `SurfaceMastery.Mastered` claim rests on, and
 * nothing else asserted it: the two host parity suites both run with the gate
 * CLOSED, so they only ever exercise `AgentsGroupedList`, and the surface's own
 * suite deliberately scopes itself to the four things the surface newly owns.
 *
 * Driven as ONE assertion over BOTH branches rather than two suites that happen
 * to agree — the distinction ISS-9216 AC5 draws. Each case reads the same
 * observable out of each branch and compares them to each other, so neither
 * branch is the oracle and a change to either one reddens.
 *
 * Deliberately NOT asserting DOM equality: the v2 surface owns its own root
 * element (which the desktop host used to supply and which carries the E2E test
 * id), so the trees differ by that wrapper by design. What must not differ is
 * what the reader can see and do.
 */

const ROWS = [
  makeComponent({
    id: "uuid-parity-subagent",
    kind: AgentComponentKind.Subagent,
    name: "Parity Orchestrator",
    slug: "subagent::parity-orchestrator",
  }),
  makeComponent({
    id: "uuid-parity-plugin",
    kind: AgentComponentKind.Plugin,
    name: "Parity Plugin",
    slug: "plugin::parity-plugin",
  }),
];

const FIRST_ROW_NAME = "Parity Orchestrator";
const TYPE_TAB_GROUP_LABEL = "Component type";
const SEARCH_LABEL = "Search components";
const TIME_WINDOW_LABEL = "Time window";
const NO_MATCH_TERM = "zzz-nothing-matches";
const RE_NO_MATCH = /no components match/i;
const RE_FILTER_BUTTON = /filter/i;
const COMPONENT_HREF_PREFIX = "/agents/";

const componentHref = (item: { slug: string }) =>
  `${COMPONENT_HREF_PREFIX}${item.slug}`;

/** Mount one branch of the gate against the same rows and the same key. */
function renderBranch(branch: "v1" | "v2") {
  const persistKey = `agents:parity-${branch}`;
  return render(
    <Wrapper dataSource={testDataSource(ROWS)}>
      {branch === "v2" ? (
        <AgentsListSurfaceV2
          getComponentHref={componentHref}
          persistKey={persistKey}
        />
      ) : (
        <AgentsGroupedList
          getComponentHref={componentHref}
          persistKey={persistKey}
        />
      )}
    </Wrapper>
  );
}

/** Everything the reader can see and act on, read the same way from either branch. */
async function readSurface(): Promise<{
  rowHrefs: (string | null)[];
  tabs: (string | null)[];
  toolbarControls: boolean[];
}> {
  await screen.findByText(FIRST_ROW_NAME);
  return {
    rowHrefs: screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.startsWith(COMPONENT_HREF_PREFIX)),
    tabs: within(screen.getByRole("radiogroup", { name: TYPE_TAB_GROUP_LABEL }))
      .getAllByRole("radio")
      .map((tab) => tab.textContent),
    toolbarControls: [
      screen.getByLabelText(SEARCH_LABEL) !== null,
      screen.getByRole("radiogroup", { name: TIME_WINDOW_LABEL }) !== null,
      screen.getByRole("button", { name: RE_FILTER_BUTTON }) !== null,
    ],
  };
}

describe("Agents list branch parity (ISS-9398)", () => {
  it("shows the same tabs, toolbar and row routes on both branches", async () => {
    const v1Mount = renderBranch("v1");
    const v1 = await readSurface();
    v1Mount.unmount();

    const v2Mount = renderBranch("v2");
    const v2 = await readSurface();
    v2Mount.unmount();

    // Compared against each other, so neither branch is the oracle.
    expect(v2).toStrictEqual(v1);
    expect(v1.rowHrefs).toEqual(ROWS.map(componentHref));
    // Not vacuous: an empty read would make two empty shapes agree forever.
    expect(v1.rowHrefs.length).toBeGreaterThan(0);
    expect(v1.tabs.length).toBeGreaterThan(1);
  });

  it("reaches the same filtered-empty copy from the same search on both branches", async () => {
    const readFilteredEmpty = async (branch: "v1" | "v2") => {
      const user = userEvent.setup();
      const mount = renderBranch(branch);
      await screen.findByText(FIRST_ROW_NAME);
      await user.type(screen.getByLabelText(SEARCH_LABEL), NO_MATCH_TERM);
      const copy = await waitFor(() => screen.getByText(RE_NO_MATCH));
      const text = copy.textContent;
      mount.unmount();
      return text;
    };

    const v1Copy = await readFilteredEmpty("v1");
    const v2Copy = await readFilteredEmpty("v2");

    expect(v2Copy).toBe(v1Copy);
    // The sentence itself, so this cannot pass on two empty strings.
    expect(v1Copy).toBe("No components match the current filters.");
  });
});
