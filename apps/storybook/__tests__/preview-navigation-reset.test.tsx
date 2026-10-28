/**
 * ISS-12901: every story renders through the preview's ONE memory navigation,
 * so a query one story writes would reach the next story unless the preview's
 * `beforeEach` resets it. FourLevelHierarchy's `hierarchyExpanded` set once
 * overrode PointerPlacement's seeded expansion in the all-stories sweep this
 * way. Two stories run in order here: the first writes a search param, and the
 * second must not see it.
 */
import { useNavigation } from "@repo/navigation/use-navigation";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { composeStory } from "@storybook/react";
import { screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

const LEAKED_PARAM = "previewResetProbe";
const LEAKED_VALUE = "leaked";
const NO_VALUE = "none";

describe("preview navigation reset", () => {
  it("starts each story at a clean URL after a story wrote a query", async () => {
    await WritesQuery.run();
    await ReadsQuery.run();

    expect(screen.getByTestId("probe-value")).toHaveTextContent(NO_VALUE);
  });
});

function QueryWriter() {
  const navigation = useNavigation();
  useEffect(() => {
    navigation.navigate(`/?${LEAKED_PARAM}=${LEAKED_VALUE}`);
  }, [navigation]);
  return null;
}

function QueryReader() {
  const search = useSearchParamsValue();
  return (
    <output data-testid="probe-value">
      {search.get(LEAKED_PARAM) ?? NO_VALUE}
    </output>
  );
}

const META = { title: "Tests/Preview navigation reset" };
const WritesQuery = composeStory({ render: () => <QueryWriter /> }, META);
const ReadsQuery = composeStory({ render: () => <QueryReader /> }, META);
