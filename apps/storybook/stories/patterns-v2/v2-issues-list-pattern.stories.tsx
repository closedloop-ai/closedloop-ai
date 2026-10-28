import type { Meta, StoryObj } from "@storybook/react";
import {
  artifactListDark,
  artifactListDefault,
  artifactListNarrow,
  artifactListPatternMeta,
} from "./artifact-list-pattern-stories";

/**
 * Patterns: the Issues list page's layout, the artifact list layout every v2
 * list shares (`artifact-list-layout.tsx`, ISS-12171).
 *
 * The Issues route already renders it: since ISS-9404 the route is
 * `IssuesIndexView`, the Documents listing with issue data, behind the
 * `issues-nav` flag. The finished page is Surfaces/Labs/Issues/Issues List;
 * its full design is DI-13 (ISS-12587).
 *
 * Controls are disabled: every story is a fixed layout state.
 */
const meta = {
  ...artifactListPatternMeta,
  title: "Patterns/Labs/Issues/Issues List",
  tags: ["preview"],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = artifactListDefault;

export const Narrow: Story = artifactListNarrow;

export const Dark: Story = artifactListDark;
