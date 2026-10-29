import {
  BATCH_ITEM_FAILURE_MESSAGE,
  BatchItemFailureCode,
} from "@repo/api/src/types/batch-mutation-result";
import { Status } from "@repo/api/src/types/result";
import { TableBulkActionBar } from "@repo/design-system/components/ui/table-bulk-action-bar";
import type { Meta, StoryObj } from "@storybook/react";
import { XIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { useArgs } from "storybook/preview-api";
import {
  expect,
  fn,
  isMockFunction,
  screen,
  userEvent,
  waitFor,
} from "storybook/test";
import { ApiError, getFriendlyError } from "../../shared/api/api-error";
import {
  BULK_REMOVE_TAG_ACTION_LABEL,
  BULK_TAG_ACTION_LABEL,
} from "../lib/bulk-tag-labels";
import { BulkTagPicker } from "./bulk-tag-picker";

const meta = {
  title: "Composites/Shared/Artifact List/Bulk Tag Picker",
  component: BulkTagPicker,
  tags: ["stable", "autodocs"],
  args: {
    isPending: false,
    isLoading: false,
    open: false,
    presentation: "button",
    options: [
      { id: "backend", label: "backend" },
      { id: "urgent", label: "urgent" },
    ],
    onOpenChange: fn(),
    onSelect: fn(async () => true),
  },
  argTypes: {
    actionLabel: { control: "text" },
    isPending: { control: "boolean" },
    isLoading: { control: "boolean" },
    open: { control: "boolean" },
    presentation: { control: "inline-radio", options: ["button", "rail"] },
    options: { control: "object" },
    errorMessage: { control: "text" },
    catalogError: { control: "text" },
    onOpenChange: { control: false },
    onSelect: { control: false },
    emptyLabel: { control: "text" },
    icon: {
      control: false,
      description:
        "Disabled because the fixture-owned ReactNode is not serializable as a Storybook control.",
    },
  },
  parameters: { layout: "centered" },
  render: RenderBulkTagPicker,
} satisfies Meta<typeof BulkTagPicker>;

// Event callbacks use the Actions panel; all rendered props have live controls above.
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Loading: Story = { args: { open: true, isLoading: true } };
export const Empty: Story = { args: { open: true, options: [] } };
export const Pending: Story = { args: { open: true, isPending: true } };
export const PartialFailure: Story = {
  args: {
    open: true,
    errorMessage:
      BATCH_ITEM_FAILURE_MESSAGE[BatchItemFailureCode.ArtifactsNotFound],
  },
};
/** A failed catalog read, worded through `getFriendlyError` as the host words it. */
export const CatalogError: Story = {
  args: {
    open: true,
    catalogError: getFriendlyError(
      new ApiError("tags read failed", Status.Error)
    ).description,
  },
};

export const OverflowingCatalog: Story = {
  args: {
    open: true,
    presentation: "rail",
    options: [
      { id: "platform-observability", label: "platform-observability" },
      { id: "backend", label: "backend" },
      { id: "urgent", label: "urgent" },
      { id: "design", label: "design" },
      { id: "infra", label: "infra" },
      { id: "needs-design", label: "needs-design" },
      { id: "frontend", label: "frontend" },
      { id: "services", label: "services" },
      { id: "api", label: "api" },
      { id: "brandnew", label: "brandnew" },
    ],
  },
  play: async ({ args }) => {
    for (const option of args.options) {
      await expect(
        screen.getByRole("button", { name: option.label })
      ).toBeInTheDocument();
    }
    const last = args.options.at(-1);
    if (!last) {
      throw new Error("The overflowing catalog has no final option");
    }
    await userEvent.click(screen.getByRole("button", { name: last.label }));
    await expect(args.onSelect).toHaveBeenCalledWith(last);
  },
};

export const Rail: Story = { args: { presentation: "rail", open: true } };
export const Open: Story = { args: { open: true } };
export const RemoveTag: Story = {
  args: {
    actionLabel: BULK_REMOVE_TAG_ACTION_LABEL,
    icon: <XIcon />,
    onSelect: fn(async () => true),
    open: true,
  },
  render: RenderRemoveTagPicker,
  play: async ({ args }) => {
    const option = args.options[0];
    if (!option) {
      throw new Error("The remove-tag catalog has no option");
    }
    await expect(
      screen.getByRole("button", { name: BULK_REMOVE_TAG_ACTION_LABEL })
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: option.label }));
    const evidence = screen.getByRole("status", {
      name: REMOVE_TAG_EVIDENCE_LABEL,
    });
    await waitFor(() => {
      expect(evidence).toHaveAttribute("data-wrapper-option-id", option.id);
      expect(evidence).toHaveAttribute("data-public-option-id", option.id);
    });
  },
};

function RenderBulkTagPicker(args: ComponentProps<typeof BulkTagPicker>) {
  const [, updateArgs] = useArgs<ComponentProps<typeof BulkTagPicker>>();
  const picker = (
    <BulkTagPicker
      {...args}
      onOpenChange={(open) => {
        args.onOpenChange(open);
        updateArgs({ open });
      }}
      onSelect={async (option) => {
        const applied = await args.onSelect(option);
        if (applied) {
          updateArgs({ open: false });
        }
        return applied;
      }}
    />
  );
  return args.presentation === "rail" ? (
    <TableBulkActionBar actionLabel="2 artifacts selected" actions={picker} />
  ) : (
    picker
  );
}

function RenderRemoveTagPicker(args: ComponentProps<typeof BulkTagPicker>) {
  const [, updateArgs] = useArgs<ComponentProps<typeof BulkTagPicker>>();
  return <RemoveTagInteractionEvidence args={args} updateArgs={updateArgs} />;
}

function RemoveTagInteractionEvidence({
  args,
  updateArgs,
}: {
  args: ComponentProps<typeof BulkTagPicker>;
  updateArgs: (args: Partial<ComponentProps<typeof BulkTagPicker>>) => void;
}) {
  const [wrapperOptionId, setWrapperOptionId] = useState<string>();
  const [publicOptionId, setPublicOptionId] = useState<string>();
  return (
    <>
      <BulkTagPicker
        {...args}
        onOpenChange={(open) => {
          args.onOpenChange(open);
          updateArgs({ open });
        }}
        onSelect={async (option) => {
          setWrapperOptionId(option.id);
          if (!isMockFunction(args.onSelect)) {
            throw new Error("Remove Tag onSelect must be a Storybook spy");
          }
          const callCount = args.onSelect.mock.calls.length;
          const applied = await args.onSelect(option);
          const calls = args.onSelect.mock.calls;
          const lastCall = calls.at(-1);
          if (calls.length !== callCount + 1 || lastCall?.[0] !== option) {
            throw new Error(
              "Remove Tag did not delegate to its public callback"
            );
          }
          setPublicOptionId(option.id);
          if (applied) {
            updateArgs({ open: false });
          }
          return applied;
        }}
      />
      <output
        aria-label={REMOVE_TAG_EVIDENCE_LABEL}
        className="sr-only"
        data-public-option-id={publicOptionId}
        data-wrapper-option-id={wrapperOptionId}
      />
    </>
  );
}

const REMOVE_TAG_EVIDENCE_LABEL = "Remove Tag interaction evidence";
