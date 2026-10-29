import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type {
  CustomFieldEntityType,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  DetailsTabGroupId,
  detailsTabGroupSelector,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  customFieldDetailsFields,
  customFieldDetailsRoutes,
} from "./custom-field-details-host-routes";

/**
 * ISS-12302 / PLN-2173 M3 and M4: the save triggers a Details host must
 * round-trip, run against the real host, its real data source and the real
 * write path, with only the transport faked. Shared so the Session and Branch
 * hosts are held to one list.
 */

export function customFieldsSection(): HTMLElement {
  const section = document.querySelector<HTMLElement>(
    detailsTabGroupSelector(DetailsTabGroupId.CustomFields)
  );
  if (!section) {
    throw new Error("no Custom fields section");
  }
  return section;
}

/**
 * The save triggers ISS-12302 decides, each round-tripped through `PUT
 * {entityPath}/custom-field-values/{fieldId}`.
 */
export function describeCustomFieldDetailsSaveTriggers({
  entityPath,
  entityType,
  itemLabel,
  renderHost,
}: {
  entityPath: string;
  entityType: CustomFieldEntityType;
  itemLabel: string;
  renderHost: (routes: FixtureRoute[]) => void;
}) {
  const valuePath = (fieldId: string) =>
    `${entityPath}/custom-field-values/${fieldId}`;

  function setup(refuse?: CustomFieldWithOptions) {
    const { definitions, labels, values } =
      customFieldDetailsFields(entityType);
    const api = customFieldDetailsRoutes({
      definitions,
      entityPath,
      refuse,
      values,
    });
    renderHost(api.routes);
    return { ...api, labels };
  }

  async function textbox(name: string) {
    return await within(await waitFor(customFieldsSection)).findByRole(
      "textbox",
      { name }
    );
  }

  describe("custom-field rows (ISS-12302)", () => {
    it("draws every applicable field, set and unset, from the entity's values read", async () => {
      const api = setup();

      expect(await textbox("Risk")).toHaveValue("high");
      expect(await textbox("Notes")).toHaveValue("");
      const section = customFieldsSection();
      for (const name of ["Risk", "Estimate", "Severity", "Labels", "Notes"]) {
        expect(within(section).getByText(name)).toBeInTheDocument();
      }
      expect(
        within(section).getByRole("button", {
          name: `Edit Labels for ${itemLabel}`,
        })
      ).toBeInTheDocument();
      expect(api.requests).toContainEqual({
        body: undefined,
        method: "GET",
        path: `${entityPath}/custom-field-values`,
      });
    });

    it("saves a TEXT field on blur", async () => {
      const api = setup();
      const input = await textbox("Risk");

      await userEvent.clear(input);
      await userEvent.type(input, "low");
      await userEvent.tab();

      await waitFor(() =>
        expect(api.writes()).toEqual([
          {
            body: {
              value: "low",
              surface: ArtifactStatusEditSurface.Detail,
            },
            method: "PUT",
            path: valuePath("risk"),
          },
        ])
      );
    });

    it("saves a TEXT field on Enter", async () => {
      const api = setup();
      const input = await textbox("Notes");

      await userEvent.type(input, "ship it{Enter}");

      await waitFor(() =>
        expect(api.writes()).toEqual([
          {
            body: {
              value: "ship it",
              surface: ArtifactStatusEditSurface.Detail,
            },
            method: "PUT",
            path: valuePath("notes"),
          },
        ])
      );
    });

    it("saves a NUMBER field on blur", async () => {
      const api = setup();
      const input = await textbox("Estimate");

      await userEvent.clear(input);
      await userEvent.type(input, "8");
      await userEvent.tab();

      await waitFor(() =>
        expect(api.writes()).toEqual([
          {
            body: { value: 8, surface: ArtifactStatusEditSurface.Detail },
            method: "PUT",
            path: valuePath("estimate"),
          },
        ])
      );
    });

    it("restores the saved value on Escape and writes nothing on the blur after", async () => {
      const api = setup();
      const input = await textbox("Risk");

      await userEvent.type(input, " and rising");
      await userEvent.keyboard("{Escape}");
      expect(input).toHaveValue("high");
      await userEvent.tab();
      // A later write is the barrier: once it has landed, a write the Escape
      // and its blur had made would have landed before it.
      const notes = await textbox("Notes");
      await userEvent.type(notes, "after");
      await userEvent.tab();

      await waitFor(() =>
        expect(api.writes()).toEqual([
          {
            body: {
              value: "after",
              surface: ArtifactStatusEditSurface.Detail,
            },
            method: "PUT",
            path: valuePath("notes"),
          },
        ])
      );
      expect(input).toHaveValue("high");
    });

    it("saves an ENUM pick with one write and closes the menu", async () => {
      const api = setup();
      await waitFor(customFieldsSection);

      await userEvent.click(
        await screen.findByRole("button", {
          name: `Edit Severity for ${itemLabel}`,
        })
      );
      await userEvent.click(screen.getByRole("menuitemradio", { name: "Low" }));

      await waitFor(() =>
        expect(api.writes()).toEqual([
          {
            body: {
              value: "low",
              surface: ArtifactStatusEditSurface.Detail,
            },
            method: "PUT",
            path: valuePath("severity"),
          },
        ])
      );
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("saves each MULTI_ENUM toggle with its own write and keeps the menu open", async () => {
      const api = setup();
      await waitFor(customFieldsSection);

      await userEvent.click(
        await screen.findByRole("button", {
          name: `Edit Labels for ${itemLabel}`,
        })
      );
      await userEvent.click(
        screen.getByRole("menuitemcheckbox", { name: "Alpha" })
      );
      await userEvent.click(
        screen.getByRole("menuitemcheckbox", { name: "Beta" })
      );

      await waitFor(() =>
        expect(api.writes()).toEqual([
          {
            body: {
              value: ["alpha"],
              surface: ArtifactStatusEditSurface.Detail,
            },
            method: "PUT",
            path: valuePath("labels"),
          },
          {
            body: {
              value: ["alpha", "beta"],
              surface: ArtifactStatusEditSurface.Detail,
            },
            method: "PUT",
            path: valuePath("labels"),
          },
        ])
      );
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    it("clears a single-choice field by writing null", async () => {
      const api = setup();
      await waitFor(customFieldsSection);

      await userEvent.click(
        await screen.findByRole("button", {
          name: `Edit Severity for ${itemLabel}`,
        })
      );
      await userEvent.click(
        screen.getByRole("menuitem", { name: "Clear Severity" })
      );

      await waitFor(() =>
        expect(api.writes()).toEqual([
          {
            body: { value: null, surface: ArtifactStatusEditSurface.Detail },
            method: "PUT",
            path: valuePath("severity"),
          },
        ])
      );
    });

    it("puts the previous value back on screen after a refused toggle", async () => {
      const { labels } = customFieldDetailsFields(entityType);
      const api = setup(labels);
      await waitFor(customFieldsSection);

      await userEvent.click(
        await screen.findByRole("button", {
          name: `Edit Labels for ${itemLabel}`,
        })
      );
      await userEvent.click(
        screen.getByRole("menuitemcheckbox", { name: "Alpha" })
      );

      // Optimistic while the write is in flight.
      await waitFor(() =>
        expect(
          screen.getByRole("menuitemcheckbox", { name: "Alpha" })
        ).toHaveAttribute("aria-checked", "true")
      );
      api.release();

      await waitFor(() =>
        expect(
          screen.getByRole("menuitemcheckbox", { name: "Alpha" })
        ).toHaveAttribute("aria-checked", "false")
      );
      expect(api.writes()).toEqual([
        {
          body: {
            value: ["alpha"],
            surface: ArtifactStatusEditSurface.Detail,
          },
          method: "PUT",
          path: valuePath("labels"),
        },
      ]);
    });
  });
}
