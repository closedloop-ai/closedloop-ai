import type { Meta, StoryObj } from "@storybook/react";
import {
  artifactListDark,
  artifactListDefault,
  artifactListNarrow,
  artifactListPatternMeta,
} from "./artifact-list-pattern-stories";

/**
 * Patterns: the Implementation Plans list page's layout, the artifact list layout every v2
 * list shares (`artifact-list-layout.tsx`, ISS-12171).
 *
 * The live app has no Implementation Plans list (plans are listed inside
 * Project Detail and My Tasks), so Surfaces/Other Pages/Implementation
 * Plans/Plans List shows this layout until one is built.
 *
 * Controls are disabled: every story is a fixed layout state.
 */
const meta = {
  ...artifactListPatternMeta,
  title: "Patterns/Other Pages/Implementation Plans/Plans List",
  tags: ["stable"],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = artifactListDefault;

export const Narrow: Story = artifactListNarrow;

export const Dark: Story = artifactListDark;
