import { composeStories } from "@storybook/react";
import { render } from "@testing-library/react";
import { describe, it } from "vitest";
import referenceMeta, {
  Dark as ReferenceDark,
  Default as ReferenceDefault,
  Empty as ReferenceEmpty,
  HostStatus as ReferenceHostStatus,
  Multiple as ReferenceMultiple,
  ReadOnly as ReferenceReadOnly,
  WriteRejects as ReferenceWriteRejects,
} from "../stories/inline-reference-cell.stories";
import tagMeta, {
  CreateTag as TagCreate,
  Dark as TagDark,
  Default as TagDefault,
  Empty as TagEmpty,
  ReadOnly as TagReadOnly,
  WriteRejects as TagWriteRejects,
} from "../stories/inline-tag-cell.stories";

/**
 * PRD-722: every story of the tag and reference champions plays to its end in
 * jsdom, so a play that stops proving its claim (Write Rejects restoring the
 * previous set, above all) reddens here rather than only in a browser run.
 */
describe.each([
  [
    "Inline Tag Cell",
    composeStories({
      default: tagMeta,
      TagDefault,
      TagEmpty,
      TagReadOnly,
      TagCreate,
      TagWriteRejects,
      TagDark,
    }),
  ],
  [
    "Inline Reference Cell",
    composeStories({
      default: referenceMeta,
      ReferenceDefault,
      ReferenceEmpty,
      ReferenceReadOnly,
      ReferenceMultiple,
      ReferenceHostStatus,
      ReferenceWriteRejects,
      ReferenceDark,
    }),
  ],
])("%s stories", (_title, stories) => {
  it.each(Object.entries(stories))("%s plays", async (_name, Story) => {
    const { container } = render(<Story />);
    await Story.play?.({ canvasElement: container });
  });
});
