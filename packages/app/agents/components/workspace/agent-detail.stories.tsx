import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
  type ComponentVersion,
} from "@repo/api/src/types/agent-component";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import type { AgentComponentsDataSource } from "../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../data-source/provider";
import { makeDetail } from "./agent-component-fixtures";
import { AgentDetail } from "./agent-detail";

/**
 * ISS-5029 canvas for the Definition panel's "this revision history is PARTIAL"
 * caption (#4391 review, cid 3717853955).
 *
 * `agent-detail-versions-truncated.test.tsx` already pins the payload matrix,
 * but it asserts the caption is IN or OUT of the DOM. That is not the question
 * this canvas answers. The caption only draws when a server cap actually bound,
 * so nobody on the team encounters it in the running app — and the thing
 * iterated on in review was precisely what no assertion holds: whether it reads
 * as support copy attached to the body box, or floats loose between the heading
 * row and the content.
 *
 * The single-revision story is the one that earns its keep. The version selector
 * only draws at `versions.length > 1`, so with one retained revision the caption
 * has nothing above it to lean on and has to stand as a claim about the history
 * rather than about a dropdown — which is why the copy was reworded. The other
 * fixtures use two revisions and hide that shape entirely.
 */

/** Detail is a full-page surface; give it a page-shaped frame to read in. */
function DetailFrame({ children }: Readonly<{ children: ReactNode }>) {
  return <main className="h-screen overflow-auto p-6">{children}</main>;
}

/**
 * ISS-5366 retired the `component-versions-truncated` gate to its enabled state,
 * so no story seeds a flag; every canvas below differs only by its PAYLOAD,
 * which is what actually drives the caption.
 */
function storyDecorator(detail: AgentComponentDetail): Decorator {
  // ISS-5697: the app-core harness is global (ISS-5665,
  // `.storybook/preview.tsx`), so this decorator carries only the data source
  // and the frame. A story that needs a flag sets
  // `parameters.appCore.enabledFlags`; the rest stay closed by default, which
  // is what {@link DefinitionAbsenceFlagOff} relies on.
  return (Story) => (
    <AgentComponentsDataSourceProvider dataSource={detailSource(detail)}>
      <DetailFrame>
        <Story />
      </DetailFrame>
    </AgentComponentsDataSourceProvider>
  );
}

// Declared above the stories, not at the bottom with the helpers: the story
// `args` below read these at module-evaluation time, and `const` has no
// hoisting, so a bottom placement would be a temporal-dead-zone crash on load.
const TRUNCATED_DETAIL = makeDetail({
  prompt: "Revision 0 body.",
  versions: [revision(0, true), revision(1, false)],
  versionsTruncated: true,
});

const SINGLE_REVISION_DETAIL = makeDetail({
  id: "uuid-detail-single-revision",
  prompt: "Revision 0 body.",
  versions: [revision(0, true)],
  versionsTruncated: true,
});

// No `versionsTruncated` key at all — the shape an older cloud, or the desktop's
// uncapped local read, actually puts on the wire. Deliberately not `false`.
const COMPLETE_HISTORY_DETAIL = makeDetail({
  id: "uuid-detail-complete-history",
  prompt: "Revision 0 body.",
  versions: [revision(0, true), revision(1, false)],
});

const meta: Meta<typeof AgentDetail> = {
  title: "App Core/Agents/Workspace/Agent Detail",
  component: AgentDetail,
  tags: ["autodocs"],
  argTypes: {
    slug: {
      control: "text",
      description:
        "Identity the detail query resolves against; each story seeds a data source keyed on it.",
    },
    backHref: { control: "text" },
    headerAction: { control: false },
    analytics: { control: false },
    getSessionHref: { control: false },
  },
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof AgentDetail>;

/**
 * Truncated with history retained: the selector draws, and the caption sits
 * under the body box as support copy for the panel it qualifies.
 */
export const TruncatedWithSelector: Story = {
  args: { backHref: "/acme/agents", slug: TRUNCATED_DETAIL.id },
  decorators: [storyDecorator(TRUNCATED_DETAIL)],
};

/**
 * Truncated down to ONE retained revision: no selector renders, so the caption
 * carries the partial-history claim alone. This is the shape the copy was
 * reworded for.
 */
export const TruncatedSingleRevision: Story = {
  args: { backHref: "/acme/agents", slug: SINGLE_REVISION_DETAIL.id },
  decorators: [storyDecorator(SINGLE_REVISION_DETAIL)],
};

/**
 * The control, now that the gate is gone: the same panel whose payload makes NO
 * truncation claim renders with no caption at all. This is the version-skew
 * shape — an older cloud, or the desktop's own uncapped local read, omits the
 * field — and pairing it against the first story is what keeps the caption
 * reviewable as a signal rather than as decoration.
 */
export const CompleteHistory: Story = {
  args: { backHref: "/acme/agents", slug: COMPLETE_HISTORY_DETAIL.id },
  decorators: [storyDecorator(COMPLETE_HISTORY_DETAIL)],
};

/**
 * ISS-5500 — the Definition panel's absence-reason matrix (#4632 review).
 *
 * Every story above renders with real prompt content, so the empty state itself
 * never drew on a canvas, let alone its variants. The RTL suite pins the strings
 * and the precedence, but neither of those is the question these answer: the copy
 * is the deliverable here, and what review kept iterating on was how a two-line
 * empty state reads inside the `bg-muted/40` box against the resolution chip
 * sitting a few centimetres above it in the header.
 *
 * The three canvases are the three reasons the panel can now give, each paired
 * with the `resolvedState` that produces it. Read them together: the whole point
 * of the change is that a reader can tell them apart, which is a comparison no
 * single-state assertion makes.
 */
const NEVER_RECORDED_DETAIL = makeDetail({
  id: "uuid-detail-never-recorded",
  kind: AgentComponentKind.Skill,
  name: "Orphan Skill",
  prompt: null,
  resolvedState: ComponentResolvedState.Unresolved,
  slug: "skill::c22ccd46",
  versions: [],
});

const UNAVAILABLE_DETAIL = makeDetail({
  id: "uuid-detail-unavailable",
  kind: AgentComponentKind.Skill,
  name: "Unreadable Skill",
  prompt: null,
  resolvedState: ComponentResolvedState.Inaccessible,
  slug: "skill::inaccessible",
  versions: [],
});

// `resolved` + a revision whose captured `content` is genuinely blank — the
// 0-byte definition the collector read successfully. The only shape that reaches
// the captured-empty carve-out, which is scoped to the resolved family.
const CAPTURED_EMPTY_DETAIL = makeDetail({
  id: "uuid-detail-captured-empty",
  kind: AgentComponentKind.Skill,
  name: "Empty Skill",
  prompt: null,
  resolvedState: ComponentResolvedState.Resolved,
  slug: "skill::captured-empty",
  versions: [{ ...revision(0, true), content: "" }],
});

/** Nothing was ever recorded — the ticket's orphan-only identity. */
export const DefinitionNeverRecorded: Story = {
  args: { backHref: "/acme/agents", slug: NEVER_RECORDED_DETAIL.id },
  decorators: [storyDecorator(NEVER_RECORDED_DETAIL)],
  parameters: {
    appCore: { enabledFlags: [AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY] },
  },
};

/** The failure case: a definition is on record and nothing readable arrived. */
export const DefinitionUnavailable: Story = {
  args: { backHref: "/acme/agents", slug: UNAVAILABLE_DETAIL.id },
  decorators: [storyDecorator(UNAVAILABLE_DETAIL)],
  parameters: {
    appCore: { enabledFlags: [AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY] },
  },
};

/** A real, correctly-captured empty definition — not a failure. */
export const DefinitionCapturedEmpty: Story = {
  args: { backHref: "/acme/agents", slug: CAPTURED_EMPTY_DETAIL.id },
  decorators: [storyDecorator(CAPTURED_EMPTY_DETAIL)],
  parameters: {
    appCore: { enabledFlags: [AGENTS_DEFINITION_EMPTY_STATE_FEATURE_FLAG_KEY] },
  },
};

/**
 * The same never-recorded payload with the flag OFF. This ships dark under
 * ISS-4779, so the single legacy line is what production renders today, and
 * putting it beside the three canvases above is the only way to eyeball what the
 * flag actually buys a reader.
 */
export const DefinitionAbsenceFlagOff: Story = {
  args: { backHref: "/acme/agents", slug: NEVER_RECORDED_DETAIL.id },
  decorators: [storyDecorator(NEVER_RECORDED_DETAIL)],
};

function revision(index: number, isCurrent: boolean): ComponentVersion {
  return {
    hash: `hash000${index}`,
    source: "",
    format: "md",
    createdAt: "2026-06-01T00:00:00.000Z",
    isCurrent,
    content: `Revision ${index} body.`,
  };
}

function detailSource(detail: AgentComponentDetail): AgentComponentsDataSource {
  return {
    scope: "story-agent-detail",
    list: () => Promise.reject(new Error("list unused in these stories")),
    detail: () => Promise.resolve(detail),
  };
}
