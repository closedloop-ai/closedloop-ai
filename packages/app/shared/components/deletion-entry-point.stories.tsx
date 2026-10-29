import { Section } from "@repo/design-system/components/ui/layout/section";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { createAgentSessionDetailFixture } from "../../agents/components/detail/agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../../agents/components/detail/agent-session-detail-view";
import {
  DeletionEntryPoint,
  type DeletionEntryPointProps,
} from "./deletion-entry-point";
import {
  DELETION_SCOPE_ITEM_KIND,
  type DeletionEffects,
  type DeletionScopeItem,
} from "./deletion-scope-review";

/**
 * ISS-12539 (PRD-808): the deletion entry point, on session detail (desktop
 * and web draw the same `AgentSessionDetailView`) and in a Settings data
 * controls section. Both open the ISS-12537 deletion scope review.
 *
 * Every string below is a neutral placeholder, one per copy slot, named after
 * the slot. None of it is product copy and none of it says what a deletion
 * does or when. Placeholders here are allowed by operator ruling (Nerys,
 * 2026-10-15), ISS-12526 thread th_Dc0RuSiAdyCvLQpC_X2G4, until the owner
 * supplies the wording. Sessions and directories are fictional.
 */
const PLACEHOLDER = {
  triggerLabel: "Placeholder: deletion entry point label",
  title: "Placeholder: dialog title",
  itemName: "Placeholder: item name",
  description: "Placeholder: dialog description",
  scopeLabel: "Placeholder: scope heading",
  effectsLabel: "Placeholder: effects heading",
  settingsTitle: "Placeholder: data controls section title",
  settingsDescription: "Placeholder: data controls section description",
} as const;

const PLACEHOLDER_EFFECTS: DeletionEffects = {
  localCopies: {
    label: "Placeholder: local copies label",
    statement: "Placeholder: effect on local copies",
  },
  serverData: {
    label: "Placeholder: server data label",
    statement: "Placeholder: effect on server data",
  },
  sharedAccess: {
    label: "Placeholder: shared access label",
    statement: "Placeholder: effect on shared access",
  },
  futureReupload: {
    label: "Placeholder: future re-upload label",
    statement: "Placeholder: effect on future re-upload",
  },
};

/** What a Settings data controls surface could put in scope. */
const SETTINGS_ITEMS: DeletionScopeItem[] = [
  {
    id: "dir-1",
    kind: DELETION_SCOPE_ITEM_KIND.DIRECTORY,
    label: "Placeholder: directory 1 label",
    detail: "Placeholder: directory 1 detail",
  },
  {
    id: "dir-2",
    kind: DELETION_SCOPE_ITEM_KIND.DIRECTORY,
    label: "Placeholder: directory 2 label",
    detail: "Placeholder: directory 2 detail",
  },
  {
    id: "ses-1",
    kind: DELETION_SCOPE_ITEM_KIND.SESSION,
    label: "Placeholder: session 1 label",
    detail: "Placeholder: session 1 detail",
  },
];

/** A fictional session: the shared fixture with every repo path replaced. */
const BASE_SESSION = createAgentSessionDetailFixture();
const FICTIONAL_SESSION = createAgentSessionDetailFixture({
  name: "Fictional sample session",
  cwd: "repos/fictional-notes-app",
  repositoryFullName: "example-org/fictional-notes-app",
  repo: "example-org/fictional-notes-app",
  worktreePath: "worktrees/fictional-notes-app-1",
  attribution: BASE_SESSION.attribution
    ? {
        ...BASE_SESSION.attribution,
        repositoryFullName: "example-org/fictional-notes-app",
        worktreePath: "worktrees/fictional-notes-app-1",
      }
    : BASE_SESSION.attribution,
});

/** On session detail, the scope is that one session. */
const SESSION_ITEMS: DeletionScopeItem[] = [
  {
    id: FICTIONAL_SESSION.id,
    kind: DELETION_SCOPE_ITEM_KIND.SESSION,
    label: FICTIONAL_SESSION.name ?? FICTIONAL_SESSION.id,
  },
];

const meta = {
  title: "Composites/Shared/Data Controls/Deletion Entry Point",
  tags: ["experimental"],
  component: DeletionEntryPoint,
  parameters: { layout: "padded" },
  args: {
    triggerLabel: PLACEHOLDER.triggerLabel,
    title: PLACEHOLDER.title,
    itemName: PLACEHOLDER.itemName,
    description: PLACEHOLDER.description,
    items: SETTINGS_ITEMS,
    scopeLabel: PLACEHOLDER.scopeLabel,
    effectsLabel: PLACEHOLDER.effectsLabel,
    effects: PLACEHOLDER_EFFECTS,
    isPending: false,
    onConfirm: fn(async () => true),
  },
  argTypes: {
    triggerLabel: {
      control: "text",
      description: "The trigger's text and accessible name.",
    },
    isPending: {
      control: "boolean",
      description: "A confirmed deletion request is in flight.",
    },
    items: {
      control: false,
      description: "Fixture: what the deletion could cover.",
    },
    initialSelectedIds: {
      control: false,
      description: "What starts in scope on every open. Defaults to all items.",
    },
    effects: { control: false },
    onConfirm: { control: false },
  },
} satisfies Meta<typeof DeletionEntryPoint>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/** Opens the entry point and checks the scope review is what it opened. */
async function openScopeReview(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(
    canvas.getByRole("button", { name: PLACEHOLDER.triggerLabel })
  );
  // The dialog portals into document.body.
  const body = within(canvasElement.ownerDocument.body);
  await expect(
    await body.findByTestId("deletion-scope-review")
  ).toBeInTheDocument();
  return body;
}

/** The entry point on its own, closed. */
export const Default: Story = {};

/** Clicking it opens the deletion scope review with everything in scope. */
export const OpensScopeReview: Story = {
  play: async ({ canvasElement }) => {
    const body = await openScopeReview(canvasElement);
    for (const checkbox of body.getAllByRole("checkbox")) {
      await expect(checkbox).toBeChecked();
    }
  },
};

function SessionDetailPlacement(args: DeletionEntryPointProps) {
  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={FICTIONAL_SESSION}
        titleActions={<DeletionEntryPoint {...args} />}
      />
    </div>
  );
}

/**
 * In context on session detail: the end of the title row, through the view's
 * `titleActions` slot. Desktop and web both render this view, inside either
 * session shell. The scope is the session itself.
 */
export const InSessionDetail: Story = {
  args: { items: SESSION_ITEMS },
  parameters: { layout: "fullscreen" },
  render: (args) => <SessionDetailPlacement {...args} />,
  play: async ({ canvasElement }) => {
    const body = await openScopeReview(canvasElement);
    await expect(body.getAllByRole("checkbox")).toHaveLength(1);
  },
};

function SettingsPlacement(args: DeletionEntryPointProps) {
  return (
    <div className="max-w-2xl">
      <Section
        description={PLACEHOLDER.settingsDescription}
        title={PLACEHOLDER.settingsTitle}
      >
        <DeletionEntryPoint {...args} />
      </Section>
    </div>
  );
}

/**
 * In context in Settings: a data controls section built from the same
 * `Section` the desktop Data & Sync tab uses. Its title and description are
 * placeholders too.
 */
export const InSettings: Story = {
  render: (args) => <SettingsPlacement {...args} />,
  play: async ({ canvasElement }) => {
    const body = await openScopeReview(canvasElement);
    await expect(body.getAllByRole("checkbox")).toHaveLength(
      SETTINGS_ITEMS.length
    );
  },
};

export const InSessionDetailDark: Story = { ...InSessionDetail, ...DARK };

export const InSettingsDark: Story = { ...InSettings, ...DARK };

/** Below `sm` the review opens as the shared dialog's bottom sheet. */
export const InSettingsNarrow: Story = {
  ...InSettings,
  globals: { viewport: { value: "390-844" } },
};
