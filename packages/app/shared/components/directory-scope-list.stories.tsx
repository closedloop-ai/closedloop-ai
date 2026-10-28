import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  type AutoExcludedDirectory,
  type DirectoryScopeEntry,
  DirectoryScopeList,
  type DirectoryScopeListCopy,
} from "./directory-scope-list";

/**
 * Placeholder strings only, one per copy slot and named after it, so a
 * designer can see which slot is which. None of this wording is approved and
 * none of it makes a product claim (AGENTS.md Human Provenance). The proposed
 * copy for Kaito/Ottilie lives on the ISS-12520 ticket thread
 * th_QgcklVVEYQVpH7ujiWRMF, not here.
 * Placeholders here are allowed by operator ruling (Nerys, 2026-10-15),
 * ISS-12520 thread th_TxJMC0V1RfSr6rtSaFQsr, until the owner supplies the
 * wording.
 */
const PLACEHOLDER_COPY: DirectoryScopeListCopy = {
  autoExcludedHeading: "Placeholder: auto-excluded heading",
  autoExcludedReason: "Placeholder: auto-excluded reason",
  empty: "Placeholder: empty",
  newlyDiscovered: "Placeholder: new badge",
  noSelection: "Placeholder: no selection",
  treeLabel: "Placeholder: tree label",
  unavailable: "Placeholder: unavailable badge",
  unavailableReason: "Placeholder: unavailable reason",
};

/** ISS-12531: the read-only reason slot, same ruling as the copy above. */
const PLACEHOLDER_READ_ONLY_REASON = "Placeholder: read-only reason";

// Fictional directories throughout.
const CODE: DirectoryScopeEntry = {
  id: "~/code",
  label: "~/code",
  children: [
    { id: "~/code/orbit-api", label: "orbit-api" },
    { id: "~/code/orbit-web", label: "orbit-web" },
    { id: "~/code/lumen-cli", label: "lumen-cli" },
  ],
};

const CLIENT_WORK: DirectoryScopeEntry = {
  id: "~/client-work",
  label: "~/client-work",
  children: [
    { id: "~/client-work/harbor", label: "harbor" },
    { id: "~/client-work/quill", label: "quill" },
  ],
};

const SANDBOX: DirectoryScopeEntry = {
  id: "~/sandbox",
  label: "~/sandbox",
};

const ENTRIES: readonly DirectoryScopeEntry[] = [CODE, CLIENT_WORK, SANDBOX];

const NEWLY_DISCOVERED_ENTRIES: readonly DirectoryScopeEntry[] = [
  {
    ...CODE,
    children: [
      ...(CODE.children ?? []),
      {
        id: "~/code/tidepool",
        label: "tidepool",
        newlyDiscovered: true,
      },
    ],
  },
  CLIENT_WORK,
  {
    id: "~/experiments",
    label: "~/experiments",
    newlyDiscovered: true,
  },
];

const UNAVAILABLE_ENTRIES: readonly DirectoryScopeEntry[] = [
  CODE,
  {
    ...CLIENT_WORK,
    children: [
      { id: "~/client-work/harbor", label: "harbor" },
      {
        id: "~/client-work/quill",
        label: "quill",
        unavailable: true,
      },
    ],
  },
  {
    id: "/Volumes/archive-drive/projects",
    label: "/Volumes/archive-drive/projects",
    unavailable: true,
  },
];

const AUTO_EXCLUDED: readonly AutoExcludedDirectory[] = [
  { id: "~/Desktop", label: "~/Desktop" },
  { id: "~/Documents", label: "~/Documents" },
  { id: "~/Downloads", label: "~/Downloads" },
];

const ALL_OPEN = [CODE.id, CLIENT_WORK.id];

/**
 * Holds the included set in story state so every row can be clicked, the way
 * a host would hold it. `includedIds` is the starting selection.
 */
function StatefulDirectoryScopeList(
  props: Parameters<typeof DirectoryScopeList>[0]
) {
  const [included, setIncluded] = useState(props.includedIds);
  return (
    <DirectoryScopeList
      {...props}
      includedIds={included}
      onIncludedIdsChange={(next) => {
        setIncluded(next);
        props.onIncludedIdsChange?.(next);
      }}
    />
  );
}

/**
 * ISS-12520: the directory scope list shared by first-time setup and the
 * Settings policy view (PRD-805 / PRD-796). It composes the design-system
 * Checkbox Tree and follows its selection contract: an included directory
 * covers everything below it, directories added later included; ticking every
 * child one by one does not include the parent.
 *
 * Folders macOS protects (ISS-11914) are listed in their own read-only group,
 * never under a user directory, because an included parent would otherwise
 * draw them as included.
 *
 * No controls: every story renders a fixture selection; the rows are clicked,
 * not configured. Every string is a placeholder; see the copy fixture.
 */
const meta = {
  title: "Composites/Shared/Data Sync/Directory Scope List",
  tags: ["experimental"],
  component: DirectoryScopeList,
  parameters: { layout: "padded", controls: { disable: true } },
  render: (args) => (
    <StatefulDirectoryScopeList
      key={JSON.stringify(args.includedIds)}
      {...args}
    />
  ),
  args: {
    autoExcluded: AUTO_EXCLUDED,
    copy: PLACEHOLDER_COPY,
    defaultExpandedIds: ALL_OPEN,
    entries: ENTRIES,
    includedIds: [CODE.id, SANDBOX.id],
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DirectoryScopeList>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/** A typical review: one folder included whole, one excluded, one leaf in. */
export const Default: Story = {};

/** Nothing was discovered and nothing has been added. */
export const Empty: Story = {
  args: { autoExcluded: [], entries: [], includedIds: [] },
};

export const EmptyDark: Story = { ...Empty, ...DARK };

/**
 * Unavailable rows carry a badge and say why, but are never locked: an offline
 * directory can still be excluded. Left alone, `quill` keeps the inherited
 * inclusion it had for when it comes back; unchecking `~/client-work` here
 * excludes `quill` with it, so nothing is collected from a directory the user
 * dropped while it was offline.
 */
export const Unavailable: Story = {
  args: { entries: UNAVAILABLE_ENTRIES, includedIds: [CLIENT_WORK.id] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const quill = canvas.getByRole("treeitem", {
      name: `quill ${PLACEHOLDER_COPY.unavailable} ${PLACEHOLDER_COPY.unavailableReason}`,
    });
    await expect(quill).toHaveAttribute("aria-checked", "true");
    await expect(quill).not.toHaveAttribute("aria-disabled");
    const clientWork = canvas.getByRole("treeitem", { name: "~/client-work" });
    await userEvent.click(clientWork);
    await expect(clientWork).toHaveAttribute("aria-checked", "false");
    await expect(quill).toHaveAttribute("aria-checked", "false");
  },
};

export const UnavailableDark: Story = { ...Unavailable, ...DARK };

/** Every directory included through its top-level folder. */
export const AllIncluded: Story = {
  args: { includedIds: [CODE.id, CLIENT_WORK.id, SANDBOX.id] },
};

/**
 * Directories are listed but none is chosen. Discovery is not permission, so
 * this is where first-time setup starts.
 */
export const NoSelection: Story = { args: { includedIds: [] } };

/**
 * Newly discovered rows carry a badge. `tidepool` sits under an included
 * folder, so it arrives included by inheritance; `~/experiments` is new at the
 * top level and stays excluded until chosen.
 */
export const NewlyDiscovered: Story = {
  args: { entries: NEWLY_DISCOVERED_ENTRIES, includedIds: [CODE.id] },
};

/**
 * Inheritance: `~/code` is included as a folder, so all of its children are
 * included and any directory added to it later will be too.
 */
export const InheritedFromParent: Story = {
  args: { autoExcluded: [], includedIds: [CODE.id] },
};

/**
 * Overriding an inherited row: excluding `orbit-web` from an included
 * `~/code` replaces the folder with its remaining children, so a directory
 * added to `~/code` later is no longer included automatically.
 */
export const OverrideInheritedChild: Story = {
  args: { autoExcluded: [], includedIds: [CODE.id] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const orbitWeb = canvas.getByRole("treeitem", { name: "orbit-web" });
    await userEvent.click(orbitWeb);
    await expect(orbitWeb).toHaveAttribute("aria-checked", "false");
    await expect(
      canvas.getByRole("treeitem", { name: "~/code" })
    ).toHaveAttribute("aria-checked", "mixed");
  },
};

/**
 * ISS-11914's automatic exclusions, read-only with a lock mark and the reason,
 * excluded whatever the selection above says.
 */
export const AutoExcluded: Story = {
  args: { includedIds: [CODE.id, CLIENT_WORK.id, SANDBOX.id] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const documents = canvas.getByRole("treeitem", { name: "~/Documents" });
    await userEvent.click(documents);
    await expect(documents).toHaveAttribute("aria-checked", "false");
  },
};

/**
 * ISS-12531: a scope set somewhere else and only reported here, such as a
 * desktop's scope shown on web. Every row is locked; each top-level row says
 * why, and a click changes nothing.
 */
export const ReadOnly: Story = {
  args: {
    entries: UNAVAILABLE_ENTRIES,
    includedIds: [CODE.id],
    readOnlyReason: PLACEHOLDER_READ_ONLY_REASON,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const code = canvas.getByRole("treeitem", { name: "~/code" });
    await expect(code).toHaveAttribute("data-readonly");
    await userEvent.click(code);
    await expect(code).toHaveAttribute("aria-checked", "true");
    const harbor = canvas.getByRole("treeitem", { name: "harbor" });
    await userEvent.click(harbor);
    await expect(harbor).toHaveAttribute("aria-checked", "false");
  },
};

export const ReadOnlyDark: Story = { ...ReadOnly, ...DARK };

/** Long paths end-truncate; the full path is the host's to show elsewhere. */
export const LongLabels: Story = {
  args: {
    autoExcluded: [],
    entries: [
      {
        id: "~/code/clients/northwind-logistics/platform/services/route-planner",
        label:
          "~/code/clients/northwind-logistics/platform/services/route-planner",
        newlyDiscovered: true,
      },
      SANDBOX,
    ],
    includedIds: [SANDBOX.id],
  },
};

export const DefaultDark: Story = { ...DARK };

export const NoSelectionDark: Story = { ...NoSelection, ...DARK };

export const NewlyDiscoveredDark: Story = { ...NewlyDiscovered, ...DARK };
