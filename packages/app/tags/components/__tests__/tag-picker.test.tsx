/**
 * Tests for the TagPicker component's new props:
 * - `trigger` render prop renders a custom trigger instead of the default
 * - `showCreate={false}` hides the create-tag option when searching
 * - Popover close resets the search input state
 */

import type { Tag, TagSummary } from "@repo/api/src/types/tag";
import { TagColor, TagEntityType } from "@repo/api/src/types/tag";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { tagKeys } from "../../hooks/use-tags";
import { TagPicker } from "../tag-picker";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREATE_TAG_PATTERN = /Create/i;

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
function renderPicker(props: Partial<Parameters<typeof TagPicker>[0]> = {}) {
  return render(
    <AppCoreStoryProviders queryData={[[tagKeys.list({}), ORG_TAGS]]}>
      <TagPicker {...defaultProps} {...props} />
    </AppCoreStoryProviders>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TagPicker", () => {
  afterEach(() => {
    cleanup();
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
});
