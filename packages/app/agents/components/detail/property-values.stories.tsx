import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import {
  SESSION_STATUS_LABELS,
  SESSION_UNKNOWN_TOOLTIP,
} from "@repo/api/src/types/session-status-display";
import type { Meta, StoryObj } from "@storybook/react";
import {
  CircleDotIcon,
  CircleHelpIcon,
  FolderIcon,
  GaugeIcon,
  GitBranchIcon,
  HashIcon,
} from "lucide-react";
import { PropertyValue } from "./property-values";
import { SessionPropertiesFrame } from "./session-properties-story-frame";

// A synthetic org slug so the linked story's href matches the production shape
// (`/{orgSlug}/branches/{branch}`) rather than a machine-specific value.
const FIXTURE_ORG_SLUG = "acme" as const;

// Long enough to overflow the Properties column's single-column track, which is
// what puts `TruncatingPropertyValue` into its clipped branch (ellipsis, focusable
// span, tooltip trigger) instead of the plain branch.
const LONG_WORKING_DIRECTORY =
  "packages/app/agents/components/detail/session-loc-per-dollar-property.stories.tsx";

// Recreate the production Properties-pane scope (agent-session-detail-view.tsx:
// the `.prd-props-section.sd3-props` section wrapping the `.prd-props` grid
// card) so `.prd-prop`, `.prd-prop-label`, `.prd-prop-value`, and the
// `.prd-prop-value-text` ellipsis defined under `.sd3-props` in
// packages/app/styles.css actually apply. Without that ancestor the rows render
// unstyled and the truncation story has no fixed-width track to clip against.

const meta = {
  title: "App Core/Agents/Detail/Property Value",
  component: PropertyValue,
  tags: ["autodocs"],
  args: { mono: false },
  argTypes: {
    children: { control: "text", table: { category: "Content" } },
    label: { control: "text", table: { category: "Content" } },
    explanation: {
      control: "text",
      description:
        "Reason a value is this build's hedge rather than a fact. Ignored when copyValue is set.",
      table: { category: "Content" },
    },
    copyValue: {
      control: "text",
      description:
        "Raw text the copy button writes. Set, it wins over href and explanation.",
      table: { category: "State" },
    },
    href: {
      control: "text",
      description:
        "In-app link target for the value. Ignored when copyValue is set.",
      table: { category: "State" },
    },
    icon: {
      control: false,
      description: "Lucide glyph for the leading slot, or null for no slot.",
      table: { category: "Appearance" },
    },
    leading: {
      control: false,
      description: "Replaces the icon slot outright when supplied.",
      table: { category: "Appearance" },
    },
    mono: { control: "boolean", table: { category: "Appearance" } },
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <SessionPropertiesFrame>
        <Story />
      </SessionPropertiesFrame>
    ),
  ],
} satisfies Meta<typeof PropertyValue>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The baseline: a plain, non-copyable, non-linked value with a leading icon.
 * Short enough not to clip, so `TruncatingPropertyValue` stays on its plain
 * branch — no tooltip, no tab stop.
 */
export const Plain: Story = {
  args: {
    icon: FolderIcon,
    label: "Repository",
    children: "closedloop-ai/symphony-alpha",
  },
};

/**
 * `mono` on: the value renders in the tabular monospace face so digit-heavy
 * metrics line up column-to-column. This is the shape `SessionLocPerDollarProperty`
 * and the other numeric rows use.
 */
export const Monospace: Story = {
  args: {
    icon: GaugeIcon,
    label: "LOC / $",
    children: "27.39",
    mono: true,
  },
};

/**
 * `copyValue` set: the value becomes a `CopyablePropertyValue` button with an
 * accessible name derived from the label ("Copy session id"), a tooltip showing
 * the full raw value, and a success toast on click. Click it to see the button's
 * accessible name flip to the copied state.
 */
export const Copyable: Story = {
  args: {
    icon: HashIcon,
    label: "Session ID",
    children: "0f6c1c3e-9a41-4f0a-bd2e-6a0f6d0b7c11",
    copyValue: "0f6c1c3e-9a41-4f0a-bd2e-6a0f6d0b7c11",
    mono: true,
  },
};

/**
 * `href` set (FEA-4256): the value itself is the in-app `@repo/navigation` link —
 * one tab stop and one hover target, never an anchor nested inside a focusable
 * span. Only rows that resolved a real target supply an `href`; a placeholder
 * value ("None") never does.
 */
export const LinkedValue: Story = {
  args: {
    icon: GitBranchIcon,
    label: "Branch",
    children: "fix/iss-4667-loc-per-dollar-reconciliation",
    href: `/${FIXTURE_ORG_SLUG}/branches/fix-iss-4667-loc-per-dollar-reconciliation`,
  },
};

/**
 * `copyValue` wins over `href`: a value cannot be both copyable and a link, so
 * supplying both renders the copy button and drops the link. Pinned here so the
 * precedence cannot silently invert into an un-clickable anchor.
 */
export const CopyableWinsOverHref: Story = {
  args: {
    icon: GitBranchIcon,
    label: "Branch",
    children: "fix/iss-4667-loc-per-dollar-reconciliation",
    copyValue: "fix/iss-4667-loc-per-dollar-reconciliation",
    href: `/${FIXTURE_ORG_SLUG}/branches/fix-iss-4667-loc-per-dollar-reconciliation`,
  },
};

/**
 * A custom `leading` node replaces the icon slot entirely — here a state dot
 * rather than a Lucide glyph. `leading` takes precedence over `icon`, so the
 * `icon` passed alongside it must not render.
 */
export const CustomLeading: Story = {
  args: {
    icon: CircleDotIcon,
    label: "State",
    children: "Running",
    leading: <span aria-hidden className="size-2 rounded-full bg-primary" />,
  },
};

/**
 * `icon: null` with no `leading`: the value renders with no leading slot at all,
 * which is how rows that would otherwise repeat their label's meaning stay quiet.
 */
export const NoLeadingSlot: Story = {
  args: {
    icon: null,
    label: "Model",
    children: "claude-opus-5",
  },
};

/**
 * Truncation (FEA-4026): a value wider than the Properties column clips with an
 * ellipsis, and only then becomes a keyboard-focusable span whose tooltip
 * carries the full text — so the complete value is reachable by keyboard and
 * assistive tech, not hover alone. Focus or hover the value to see it.
 */
export const Truncated: Story = {
  args: {
    icon: FolderIcon,
    label: "Working directory",
    children: LONG_WORKING_DIRECTORY,
    mono: true,
  },
};

/**
 * Truncation on a LINKED value: the clipped element is the anchor itself, so it
 * is both the single tab stop and the tooltip trigger — the case that would
 * otherwise regress into an anchor nested inside a separate focusable span.
 */
export const TruncatedLink: Story = {
  args: {
    icon: GitBranchIcon,
    label: "Branch",
    children:
      "bot/nightly-storyteller-steve-2026-08-01-loc-per-dollar-backfill",
    href: `/${FIXTURE_ORG_SLUG}/branches/bot-nightly-storyteller-steve-2026-08-01`,
  },
};

/**
 * `explanation` set (ISS-4654): the value's word is this build's HEDGE rather
 * than a fact about the session, so the row carries the reason with it — the
 * same disclosure the Sessions list's Unknown pill has had since ISS-4997.
 *
 * Hover or FOCUS it: the sentence is in the tooltip for a sighted user and in
 * the accessible name (visible word first, per WCAG 2.5.3 Label in Name) for
 * everyone else, because a hover-only tooltip reaches neither keyboard nor
 * touch. It is deliberately the only row that gets this treatment — a value that
 * states a fact says nothing extra.
 */
export const Explained: Story = {
  args: {
    icon: CircleHelpIcon,
    label: "Status",
    children: SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.UNKNOWN],
    explanation: SESSION_UNKNOWN_TOOLTIP,
  },
};
