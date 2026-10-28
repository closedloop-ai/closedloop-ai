import type { Priority } from "@repo/api/src/types/common";
import { type ComponentProps, useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DocumentsView } from "./documents-view";

/** Documents held in story state, so a picked priority lands on its row. */
export function PriorityEditingDocumentsView(
  props: ComponentProps<typeof DocumentsView>
) {
  const [documents, setDocuments] = useState(props.documents);
  const updatePriority = (itemId: string, priority: Priority | null) => {
    setDocuments((current) =>
      current.map((document) =>
        document.id === itemId ? { ...document, priority } : document
      )
    );
  };
  return (
    <DocumentsView
      {...props}
      documents={documents}
      editHandlers={{ onUpdatePriority: updatePriority }}
    />
  );
}

/**
 * Picks Urgent from the High row's priority menu, and completes only once the
 * edit has landed: the menu has closed and the row reads the new priority
 * (ISS-12901: the play failed on the menu's first frame and the story ended
 * with the menu still open).
 */
export async function playPriorityEditing(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const body = within(canvasElement.ownerDocument.body);
  await userEvent.click(canvas.getByRole("button", { name: "Priority: High" }));
  const urgent = await body.findByRole("menuitem", { name: "Urgent" });
  // The menu fades in from opacity 0, which `toBeVisible` reads as hidden, so
  // a check taken on the first frame fails the play; wait for the open state.
  await waitFor(() => expect(urgent).toBeVisible());
  await userEvent.click(urgent);
  await waitFor(() => expect(body.queryByRole("menu")).toBeNull());
  await waitFor(() =>
    expect(
      canvas.getByRole("button", { name: "Priority: Urgent" })
    ).toBeVisible()
  );
  await expect(
    canvas.queryByRole("button", { name: "Priority: High" })
  ).toBeNull();
}
