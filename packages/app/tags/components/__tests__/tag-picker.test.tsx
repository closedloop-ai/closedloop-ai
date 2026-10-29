/**
 * Tests for the TagPicker component's new props:
 * - `trigger` render prop renders a custom trigger instead of the default
 * - `showCreate={false}` hides the create-tag option when searching
 * - Popover close resets the search input state
 */

import type { Tag, TagSummary } from "@repo/api/src/types/tag";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import { TAG_CREATE_COLOR_FLAG_KEY } from "@repo/api/src/types/tag-create-color-flag";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import { tagKeys } from "../../hooks/use-tags";
import { TagPicker } from "../tag-picker";

// Fixtures

const CREATE_TAG_PATTERN = /Create/i;
const PICK_A_COLOR_PATTERN = /Pick a color for/i;

const ORG_TAGS: Tag[] = [
  {
    id: "t1",
    organizationId: "org-1",
    name: "backend",
    color: TagColor.Blue,
    createdById: "user-1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  },
  {
    id: "t2",
    organizationId: "org-1",
    name: "urgent",
    color: TagColor.Red,
    createdById: "user-1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  },
];

const NO_APPLIED_TAGS: TagSummary[] = [];

const defaultProps = {
  entityType: TagEntityType.Artifact,
  entityId: "doc-1",
  appliedTags: NO_APPLIED_TAGS,
};

/**
 * Renders TagPicker with the shared storybook harness, seeding the
 * org-tags query so the picker populates without a real API.
 */
function renderPicker(
  props: Partial<Parameters<typeof TagPicker>[0]> = {},
  harness: {
    apiRoutes?: FixtureRoute[];
    enabledFlags?: readonly string[];
  } = {}
) {
  return render(
    <AppCoreStoryProviders
      apiRoutes={harness.apiRoutes}
      enabledFlags={harness.enabledFlags}
      queryData={[[tagKeys.list({}), ORG_TAGS]]}
    >
      <TagPicker {...defaultProps} {...props} />
    </AppCoreStoryProviders>
  );
}

/**
 * The created tag the API answers `POST /tags` with. `teal` is deliberately a
 * colour NEITHER seeded org tag carries, so the swatch the step marks selected
 * can only have come from this response.
 */
const CREATED_TAG: Tag = {
  id: "t3",
  organizationId: "org-1",
  name: "brandnew",
  color: TagColor.Teal,
  createdById: "user-1",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

/** Colours the PATCH route actually received, so a dropped write is visible. */
const patchedColors: string[] = [];

/** Entity ids the apply route actually received, newest last. */
const appliedEntityIds: string[] = [];

const CREATE_TAG_ROUTES: FixtureRoute[] = [
  // The list read must stay registered: an override drops the harness defaults,
  // and an unregistered `GET /tags` resolves to `{}`, which the picker's
  // `filter` then throws on the moment the create mutation invalidates it.
  { method: "GET", path: "/tags", respond: () => ORG_TAGS },
  { method: "POST", path: "/tags", respond: () => CREATED_TAG },
  {
    method: "PATCH",
    path: "/tags/*",
    respond: ({ body }) => {
      const input = (body ?? {}) as { color?: string };
      if (input.color) {
        patchedColors.push(input.color);
      }
      return { ...CREATED_TAG, color: input.color ?? CREATED_TAG.color };
    },
  },
  {
    method: "POST",
    path: "/entity-tags",
    respond: ({ body }) => {
      const input = (body ?? {}) as { entityId?: string };
      if (input.entityId) {
        appliedEntityIds.push(input.entityId);
      }
      return { applied: true };
    },
  },
];

/** Opens the picker and types a name that matches no existing tag. */
async function typeNewTagName() {
  fireEvent.click(screen.getByText("Add tag"));
  const input = await screen.findByPlaceholderText("Search tags...");
  fireEvent.change(input, { target: { value: "brandnew" } });
  return input;
}

const SEARCH_PLACEHOLDER = "Search tags...";
const COLOR_WRITE_FAILED_PATTERN = /didn’t save/i;
/** The `ColorSwatchGrid` selection ring; the only render of "this is chosen". */
const SELECTED_SWATCH_CLASS = "ring-offset-1";

/**
 * The tag routes with `POST /tags` held open until the returned `release` is
 * called, so a test can act while the create is genuinely in flight rather than
 * racing a resolved promise.
 */
function heldCreateRoutes(): {
  routes: FixtureRoute[];
  release: () => void;
} {
  let release = () => {
    // Replaced synchronously by the promise executor below.
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    routes: CREATE_TAG_ROUTES.map((route) =>
      route.method === "POST" && route.path === "/tags"
        ? {
            ...route,
            respond: async () => {
              await held;
              return CREATED_TAG;
            },
          }
        : route
    ),
  };
}

// Tests

describe("TagPicker", () => {
  afterEach(() => {
    cleanup();
    patchedColors.length = 0;
    appliedEntityIds.length = 0;
  });

  describe("trigger prop", () => {
    it("renders the custom trigger element when trigger prop is provided", () => {
      renderPicker({
        trigger: <button type="button">custom trigger</button>,
      });

      expect(screen.getByText("custom trigger")).toBeInTheDocument();
    });

    it("does not render the default 'Add tag' button when a custom trigger is provided", () => {
      renderPicker({
        trigger: <button type="button">custom trigger</button>,
      });

      expect(screen.queryByText("Add tag")).not.toBeInTheDocument();
    });

    it("renders the default 'Add tag' button when no trigger prop is provided", () => {
      renderPicker();

      expect(screen.getByText("Add tag")).toBeInTheDocument();
    });
  });

  describe("Enter key behavior", () => {
    it("shows an Enter key hint on the create-option button", async () => {
      renderPicker();
      fireEvent.click(screen.getByText("Add tag"));

      const input = await screen.findByPlaceholderText("Search tags...");
      fireEvent.change(input, { target: { value: "brandnew" } });

      expect(screen.getByText("Enter")).toBeInTheDocument();
    });

    it("applies an existing tag when Enter is pressed with an exact name match", async () => {
      renderPicker();
      fireEvent.click(screen.getByText("Add tag"));

      const input = await screen.findByPlaceholderText("Search tags...");
      fireEvent.change(input, { target: { value: "backend" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(input).toHaveValue("");
      });
    });

    it("creates a new tag when Enter is pressed with non-matching text", async () => {
      renderPicker();
      fireEvent.click(screen.getByText("Add tag"));

      const input = await screen.findByPlaceholderText("Search tags...");
      fireEvent.change(input, { target: { value: "brandnew" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(input).toHaveValue("");
      });
    });

    it("does nothing when Enter is pressed with non-matching text and showCreate is false", async () => {
      renderPicker({ showCreate: false });
      fireEvent.click(screen.getByText("Add tag"));

      const input = await screen.findByPlaceholderText("Search tags...");
      fireEvent.change(input, { target: { value: "brandnew" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(input).toHaveValue("brandnew");
    });

    it("does nothing when Enter is pressed with empty search text", async () => {
      renderPicker();
      fireEvent.click(screen.getByText("Add tag"));

      const input = await screen.findByPlaceholderText("Search tags...");
      fireEvent.keyDown(input, { key: "Enter" });

      expect(input).toHaveValue("");
    });
  });

  describe("showCreate prop", () => {
    it("hides the create-tag option when showCreate={false} and search text is entered", async () => {
      renderPicker({ showCreate: false });

      // Open the popover
      fireEvent.click(screen.getByText("Add tag"));

      const input = await screen.findByPlaceholderText("Search tags...");
      fireEvent.change(input, { target: { value: "newtagname" } });

      expect(screen.queryByText(CREATE_TAG_PATTERN)).not.toBeInTheDocument();
    });

    it("shows the create-tag option when showCreate is true (default) and search does not match any existing tag", async () => {
      renderPicker({ showCreate: true });

      fireEvent.click(screen.getByText("Add tag"));

      const input = await screen.findByPlaceholderText("Search tags...");
      fireEvent.change(input, { target: { value: "brandnew" } });

      await waitFor(() => {
        expect(screen.getByText(CREATE_TAG_PATTERN)).toBeInTheDocument();
      });
    });

    it("does not show the create-tag option when search text exactly matches an existing tag name", async () => {
      renderPicker({ showCreate: true });

      fireEvent.click(screen.getByText("Add tag"));

      const input = await screen.findByPlaceholderText("Search tags...");
      // "backend" exactly matches ORG_TAGS[0]
      fireEvent.change(input, { target: { value: "backend" } });

      expect(screen.queryByText(CREATE_TAG_PATTERN)).not.toBeInTheDocument();
    });
  });

  describe("independent mutation permissions", () => {
    it("allows applying without exposing removal", async () => {
      renderPicker({
        appliedTags: [ORG_TAGS[0]],
        canApply: true,
        canRemove: false,
        trigger: <button type="button">edit tags</button>,
      });
      fireEvent.click(screen.getByText("edit tags"));

      expect(
        await screen.findByRole("button", { name: "backend" })
      ).toBeDisabled();
      expect(screen.getByRole("button", { name: "urgent" })).toBeEnabled();
    });

    it("allows removing without exposing apply or create actions", async () => {
      renderPicker({
        appliedTags: [ORG_TAGS[0]],
        canApply: false,
        canRemove: true,
        trigger: <button type="button">edit tags</button>,
      });
      fireEvent.click(screen.getByText("edit tags"));

      expect(
        await screen.findByRole("button", { name: "backend" })
      ).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: "urgent" })
      ).not.toBeInTheDocument();
    });
  });

  describe("search state reset on close", () => {
    it("clears the search input when the popover is closed and reopened", async () => {
      renderPicker();

      // Open the popover
      const defaultTriggerButton = screen.getByText("Add tag");
      fireEvent.click(defaultTriggerButton);

      const input = await screen.findByPlaceholderText("Search tags...");
      fireEvent.change(input, { target: { value: "some search" } });
      expect(input).toHaveValue("some search");

      // Close by pressing Escape — Radix Popover closes on Escape
      fireEvent.keyDown(input, { key: "Escape" });

      await waitFor(() => {
        expect(
          screen.queryByPlaceholderText("Search tags...")
        ).not.toBeInTheDocument();
      });

      // Reopen the popover
      fireEvent.click(screen.getByText("Add tag"));

      const reopenedInput =
        await screen.findByPlaceholderText("Search tags...");
      expect(reopenedInput).toHaveValue("");
    });
  });

  /**
   * ISS-6385. Both directions are asserted against the SAME locator, so a
   * colour step that never renders at all would pass the off-case and fail the
   * on-case rather than passing both.
   */
  describe("create-then-pick-colour step (TAG_CREATE_COLOR_FLAG_KEY)", () => {
    it("offers the canonical swatch grid for the tag it just created when the flag is on", async () => {
      renderPicker(
        {},
        {
          apiRoutes: CREATE_TAG_ROUTES,
          enabledFlags: [TAG_CREATE_COLOR_FLAG_KEY],
        }
      );
      const input = await typeNewTagName();
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByText(PICK_A_COLOR_PATTERN)).toBeInTheDocument();
      // Named by colour, so the choice never rests on hue alone (WCAG 1.4.1),
      // and drawn from the canonical vocabulary rather than a local palette.
      expect(
        screen.getByRole("button", { name: TagColor.Violet })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: TagColor.Teal })
      ).toBeInTheDocument();

      // Picking must actually WRITE. Asserting only that the grid renders
      // leaves `handlePickColor`'s updateTag call unexercised, so deleting it
      // would keep this green.
      fireEvent.click(screen.getByRole("button", { name: TagColor.Violet }));
      await waitFor(() => {
        expect(patchedColors).toEqual([TagColor.Violet]);
      });
      // ...and the step closes, returning the picker to its list.
      expect(screen.queryByText(PICK_A_COLOR_PATTERN)).not.toBeInTheDocument();
    });

    it("closes on the created tag with no colour step when the flag is off", async () => {
      renderPicker({}, { apiRoutes: CREATE_TAG_ROUTES });
      const input = await typeNewTagName();
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(input).toHaveValue("");
      });
      expect(screen.queryByText(PICK_A_COLOR_PATTERN)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: TagColor.Violet })
      ).not.toBeInTheDocument();
    });

    it("does not resurrect the step for a create the user closed the popover on", async () => {
      const { routes, release } = heldCreateRoutes();
      renderPicker(
        {},
        { apiRoutes: routes, enabledFlags: [TAG_CREATE_COLOR_FLAG_KEY] }
      );
      const input = await typeNewTagName();
      fireEvent.keyDown(input, { key: "Enter" });

      // Dismiss while the POST is still unresolved.
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => {
        expect(
          screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)
        ).not.toBeInTheDocument();
      });
      release();

      // The apply that follows the create is the observable proof the create's
      // onSuccess ran, so the assertion below is a bounded event wait rather
      // than a hope that the promise settled in time.
      await waitFor(() => {
        expect(appliedEntityIds).toContain(defaultProps.entityId);
      });

      fireEvent.click(screen.getByText("Add tag"));
      expect(
        await screen.findByPlaceholderText(SEARCH_PLACEHOLDER)
      ).toBeInTheDocument();
      expect(screen.queryByText(PICK_A_COLOR_PATTERN)).not.toBeInTheDocument();
    });

    it("keeps the step, and the colour, when the write fails — and the retry lands", async () => {
      // Same object the fixture transport reads `status` off per call, so the
      // second attempt can succeed where the first did not.
      const patchRoute = CREATE_TAG_ROUTES.find(
        (route) => route.method === "PATCH"
      ) as FixtureRoute;
      const routes = CREATE_TAG_ROUTES.map((route) =>
        route === patchRoute ? { ...route, status: 500 } : route
      );
      const failingPatch = routes.find(
        (route) => route.method === "PATCH"
      ) as FixtureRoute;

      renderPicker(
        {},
        { apiRoutes: routes, enabledFlags: [TAG_CREATE_COLOR_FLAG_KEY] }
      );
      const input = await typeNewTagName();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByText(PICK_A_COLOR_PATTERN)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: TagColor.Violet }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        COLOR_WRITE_FAILED_PATTERN
      );
      // The step is still standing, still holding the colour that was asked
      // for — closing here left the tag on its server default and took the
      // only in-place retry with it.
      expect(screen.getByText(PICK_A_COLOR_PATTERN)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: TagColor.Violet })).toHaveClass(
        SELECTED_SWATCH_CLASS
      );
      expect(
        screen.getByRole("button", { name: TagColor.Teal })
      ).not.toHaveClass(SELECTED_SWATCH_CLASS);

      failingPatch.status = 200;
      fireEvent.click(screen.getByRole("button", { name: TagColor.Violet }));

      await waitFor(() => {
        expect(
          screen.queryByText(PICK_A_COLOR_PATTERN)
        ).not.toBeInTheDocument();
      });
      expect(patchedColors).toEqual([TagColor.Violet, TagColor.Violet]);
    });

    it("does not carry one tag's failed write onto the next tag's step", async () => {
      // `updateTag.isError` survives until the next `mutate`, so a step opened
      // for a DIFFERENT tag would inherit the previous tag's alert and tell the
      // user a write failed that was never attempted.
      const routes = CREATE_TAG_ROUTES.map((route) =>
        route.method === "PATCH" ? { ...route, status: 500 } : route
      );
      renderPicker(
        {},
        { apiRoutes: routes, enabledFlags: [TAG_CREATE_COLOR_FLAG_KEY] }
      );
      const input = await typeNewTagName();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByText(PICK_A_COLOR_PATTERN)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: TagColor.Violet }));
      expect(await screen.findByRole("alert")).toBeInTheDocument();

      // Walk away from that tag and create another one.
      fireEvent.keyDown(screen.getByRole("button", { name: TagColor.Violet }), {
        key: "Escape",
      });
      await waitFor(() => {
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      });
      const reopened = await (async () => {
        fireEvent.click(screen.getByText("Add tag"));
        const next = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
        fireEvent.change(next, { target: { value: "brandnew" } });
        return next;
      })();
      fireEvent.keyDown(reopened, { key: "Enter" });

      expect(await screen.findByText(PICK_A_COLOR_PATTERN)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("drops the step when the same picker is handed a different entity", async () => {
      // packages/app/AGENTS.md: transient state is scoped to the entity
      // identity, and same-component navigation is the case that must be
      // covered. A row-recycling table hands a mounted picker a new entityId
      // without unmounting it.
      const view = render(
        <AppCoreStoryProviders
          apiRoutes={CREATE_TAG_ROUTES}
          enabledFlags={[TAG_CREATE_COLOR_FLAG_KEY]}
          queryData={[[tagKeys.list({}), ORG_TAGS]]}
        >
          <TagPicker {...defaultProps} />
        </AppCoreStoryProviders>
      );
      const input = await typeNewTagName();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByText(PICK_A_COLOR_PATTERN)).toBeInTheDocument();

      view.rerender(
        <AppCoreStoryProviders
          apiRoutes={CREATE_TAG_ROUTES}
          enabledFlags={[TAG_CREATE_COLOR_FLAG_KEY]}
          queryData={[[tagKeys.list({}), ORG_TAGS]]}
        >
          <TagPicker {...defaultProps} entityId="doc-2" />
        </AppCoreStoryProviders>
      );

      await waitFor(() => {
        expect(
          screen.queryByText(PICK_A_COLOR_PATTERN)
        ).not.toBeInTheDocument();
      });
      // The picker is usable for the NEW row rather than stuck on a dead step.
      expect(
        screen.getByPlaceholderText(SEARCH_PLACEHOLDER)
      ).toBeInTheDocument();
    });
  });
});
