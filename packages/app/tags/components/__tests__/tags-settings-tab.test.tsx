import type { Tag } from "@repo/api/src/types/tag";
import { TAG_COLORS, TagColor } from "@repo/api/src/types/tag";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../shared/storybook/fixture-fetch";
import { tagKeys } from "../../hooks/use-tags";
import { TagsSettingsTab } from "../tags-settings-tab";

const mockToastSuccess = vi.fn();

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

const NEW_TAG_NAME_LABEL = "New tag name";
const RENAME_LABEL = "Rename tag";
const DELETE_DESCRIPTION_REGEX =
  /This will remove the tag "backend" from all artifacts/;

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

type RecordedRequest = { method: string; pathname: string; body: unknown };

const requests: RecordedRequest[] = [];

function record(method: string, respond: (body: unknown) => unknown) {
  return ({ pathname, body }: { pathname: string; body: unknown }) => {
    requests.push({ method, pathname, body });
    return respond(body);
  };
}

const ROUTES: FixtureRoute[] = [
  { method: "GET", path: "/tags", respond: () => ORG_TAGS },
  {
    method: "POST",
    path: "/tags",
    respond: record("POST", () => ({ ...ORG_TAGS[0], id: "t3" })),
  },
  {
    method: "PATCH",
    path: "/tags/*",
    respond: record("PATCH", () => ORG_TAGS[0]),
  },
  {
    method: "DELETE",
    path: "/tags/*",
    respond: record("DELETE", () => ({ deleted: true })),
  },
];

function writes(method: string) {
  return requests.filter((request) => request.method === method);
}

function renderTab() {
  return render(
    <AppCoreStoryProviders
      apiRoutes={ROUTES}
      queryData={[[tagKeys.list({}), ORG_TAGS]]}
    >
      <TagsSettingsTab />
    </AppCoreStoryProviders>
  );
}

async function openCreateForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Create tag" }));
  return screen.getByRole("textbox", { name: NEW_TAG_NAME_LABEL });
}

describe("TagsSettingsTab", () => {
  beforeEach(() => {
    requests.length = 0;
    mockToastSuccess.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("creates a trimmed tag in the next palette colour and closes the form", async () => {
    const user = userEvent.setup({ delay: null });
    renderTab();

    expect(
      screen.queryByRole("textbox", { name: NEW_TAG_NAME_LABEL })
    ).toBeNull();
    const input = await openCreateForm(user);
    expect(screen.getByRole("button", { name: "Create tag" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();

    await user.type(input, "  frontend  ");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(writes("POST")).toHaveLength(1));
    // Two tags exist, so the form seeds the third palette colour.
    expect(writes("POST")[0].body).toEqual({
      name: "frontend",
      color: TAG_COLORS[ORG_TAGS.length],
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: NEW_TAG_NAME_LABEL })
      ).toBeNull()
    );
    expect(screen.getByRole("button", { name: "Create tag" })).toBeEnabled();

    // The draft name is cleared, so the next create starts empty.
    const reopened = await openCreateForm(user);
    expect(reopened).toHaveValue("");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("creates with the colour picked in the form", async () => {
    const user = userEvent.setup({ delay: null });
    renderTab();

    const input = await openCreateForm(user);
    await user.click(
      screen.getByRole("button", {
        name: `Color: ${TAG_COLORS[ORG_TAGS.length]}`,
      })
    );
    await user.click(
      await screen.findByRole("button", { name: TagColor.Teal })
    );
    await user.type(input, "infra{Enter}");

    await waitFor(() => expect(writes("POST")).toHaveLength(1));
    expect(writes("POST")[0].body).toEqual({
      name: "infra",
      color: TagColor.Teal,
    });
  });

  it("does not create a whitespace-only name from the Enter key", async () => {
    const user = userEvent.setup({ delay: null });
    renderTab();

    const input = await openCreateForm(user);
    await user.type(input, "   {Enter}");

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: NEW_TAG_NAME_LABEL })
    ).toBeInTheDocument();

    // A real name afterwards proves the blank Enter wrote nothing.
    await user.type(input, "x{Enter}");
    await waitFor(() => expect(writes("POST")).toHaveLength(1));
    expect(writes("POST")[0].body).toMatchObject({ name: "x" });
  });

  it("closes the create form on Escape and on Cancel without writing", async () => {
    const user = userEvent.setup({ delay: null });
    renderTab();

    const input = await openCreateForm(user);
    await user.type(input, "draft{Escape}");
    expect(
      screen.queryByRole("textbox", { name: NEW_TAG_NAME_LABEL })
    ).toBeNull();

    await openCreateForm(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("textbox", { name: NEW_TAG_NAME_LABEL })
    ).toBeNull();
    expect(writes("POST")).toHaveLength(0);
  });

  it("renames a tag to a trimmed new name", async () => {
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(screen.getByRole("button", { name: "backend" }));
    const rename = screen.getByRole("textbox", { name: RENAME_LABEL });
    await user.clear(rename);
    await user.type(rename, " services {Enter}");

    await waitFor(() => expect(writes("PATCH")).toHaveLength(1));
    expect(writes("PATCH")[0]).toEqual({
      method: "PATCH",
      pathname: "/tags/t1",
      body: { name: "services" },
    });
  });

  it("does not write a rename that is blank or matches the current name after trimming", async () => {
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(screen.getByRole("button", { name: "backend" }));
    let rename = screen.getByRole("textbox", { name: RENAME_LABEL });
    await user.clear(rename);
    await user.type(rename, " backend {Enter}");

    await user.click(screen.getByRole("button", { name: "backend" }));
    rename = screen.getByRole("textbox", { name: RENAME_LABEL });
    await user.clear(rename);
    await user.type(rename, "   {Enter}");

    // A real rename afterwards proves neither earlier save wrote anything.
    await user.click(screen.getByRole("button", { name: "backend" }));
    rename = screen.getByRole("textbox", { name: RENAME_LABEL });
    await user.clear(rename);
    await user.type(rename, "api{Enter}");

    await waitFor(() => expect(writes("PATCH")).toHaveLength(1));
    expect(writes("PATCH")[0].body).toEqual({ name: "api" });
  });

  it("writes a recolour only when the colour actually changes", async () => {
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(
      screen.getAllByRole("button", { name: `Color: ${TagColor.Blue}` })[0]
    );
    await user.click(
      await screen.findByRole("button", { name: TagColor.Blue })
    );
    expect(writes("PATCH")).toHaveLength(0);

    // The swatch popover stays open after a pick.
    await user.click(screen.getByRole("button", { name: TagColor.Green }));

    await waitFor(() => expect(writes("PATCH")).toHaveLength(1));
    expect(writes("PATCH")[0]).toEqual({
      method: "PATCH",
      pathname: "/tags/t1",
      body: { color: TagColor.Green },
    });
  });

  it("deletes a tag after confirmation and announces it", async () => {
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(
      screen.getAllByRole("button", { name: "Open actions menu" })[0]
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete tag" })
    );
    expect(
      await screen.findByText(DELETE_DESCRIPTION_REGEX)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith('Tag "backend" deleted')
    );
    expect(writes("DELETE")).toEqual([
      { method: "DELETE", pathname: "/tags/t1", body: undefined },
    ]);
    await waitFor(() =>
      expect(screen.queryByText(DELETE_DESCRIPTION_REGEX)).toBeNull()
    );
  });

  it("dismisses the delete confirmation without deleting", async () => {
    const user = userEvent.setup({ delay: null });
    renderTab();

    await user.click(
      screen.getAllByRole("button", { name: "Open actions menu" })[0]
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete tag" })
    );
    await screen.findByText(DELETE_DESCRIPTION_REGEX);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByText(DELETE_DESCRIPTION_REGEX)).toBeNull()
    );
    expect(writes("DELETE")).toHaveLength(0);
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
