import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditableFeatureTitle } from "../editable-feature-title";

const mockUseUpdateDocument = vi.fn();
const mockMutateAsync = vi.fn();
const FEATURE_TITLE_PLACEHOLDER = "Untitled feature";

vi.mock("@/hooks/queries/use-documents", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-documents");
  return {
    ...actual,
    useUpdateDocument: () => mockUseUpdateDocument(),
  };
});

describe("EditableFeatureTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUpdateDocument.mockReturnValue({
      mutateAsync: mockMutateAsync,
    });
    mockMutateAsync.mockResolvedValue({
      id: "feature-1",
      title: "Updated feature title",
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the title as a textarea so long titles can wrap", () => {
    render(
      <EditableFeatureTitle
        documentId="feature-1"
        initialTitle="A very long feature title that should wrap naturally"
      />
    );

    const titleField = screen.getByPlaceholderText(FEATURE_TITLE_PLACEHOLDER);

    expect(titleField.tagName).toBe("TEXTAREA");
    expect(titleField).toHaveValue(
      "A very long feature title that should wrap naturally"
    );
  });

  it("saves the updated title when Enter is pressed", async () => {
    render(
      <EditableFeatureTitle
        documentId="feature-1"
        initialTitle="Original feature title"
      />
    );

    const titleField = screen.getByPlaceholderText(FEATURE_TITLE_PLACEHOLDER);

    fireEvent.change(titleField, {
      target: { value: "Updated feature title" },
    });
    fireEvent.keyDown(titleField, { key: "Enter" });

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        id: "feature-1",
        title: "Updated feature title",
      });
    });
  });

  it("collapses pasted line breaks before saving the title", async () => {
    render(
      <EditableFeatureTitle
        documentId="feature-1"
        initialTitle="Original feature title"
      />
    );

    const titleField = screen.getByPlaceholderText(FEATURE_TITLE_PLACEHOLDER);

    fireEvent.change(titleField, {
      target: { value: "Updated\nfeature\r\ntitle" },
    });

    expect(titleField).toHaveValue("Updated feature title");

    fireEvent.keyDown(titleField, { key: "Enter" });

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        id: "feature-1",
        title: "Updated feature title",
      });
    });
  });
});
