"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditableProjectTitle } from "../editable-project-title";

// Mock mutate function
const mockMutate = vi.fn();

// Mock the useUpdateProject hook
vi.mock("@/hooks/queries/use-projects", () => ({
  useUpdateProject: () => ({
    mutate: mockMutate,
    isPending: false,
  }),
}));

// Mock the toast module
vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

// Get typed mock reference
const mockToast = vi.mocked(toast);

describe("EditableProjectTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders initial title in button element", () => {
    const { container } = render(
      <EditableProjectTitle initialTitle="My Project" projectId="proj-123" />
    );
    expect(container).toBeDefined();
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("My Project");
  });

  it("button has cursor-pointer class", () => {
    render(
      <EditableProjectTitle initialTitle="My Project" projectId="proj-123" />
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("cursor-pointer");
  });

  it("enters edit mode on click", () => {
    render(
      <EditableProjectTitle initialTitle="My Project" projectId="proj-123" />
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input).toBeDefined();
    expect(input.value).toBe("My Project");
  });

  it("input is auto-focused when entering edit mode", () => {
    render(
      <EditableProjectTitle initialTitle="My Project" projectId="proj-123" />
    );
    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    expect(document.activeElement).toBe(input);
  });

  it("saves on blur with changed value", async () => {
    // Configure mock to simulate successful mutation
    mockMutate.mockImplementation((_input, options) => {
      options?.onSuccess?.();
    });

    render(
      <EditableProjectTitle initialTitle="Old Title" projectId="proj-123" />
    );

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "New Title" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        {
          id: "proj-123",
          name: "New Title",
        },
        expect.any(Object)
      );
    });
  });

  it("saves on Enter key with changed value", async () => {
    mockMutate.mockImplementation((_input, options) => {
      options?.onSuccess?.();
    });

    render(
      <EditableProjectTitle initialTitle="Old Title" projectId="proj-123" />
    );

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "New Title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        {
          id: "proj-123",
          name: "New Title",
        },
        expect.any(Object)
      );
    });
  });

  it("calls onTitleChange callback on successful save", async () => {
    mockMutate.mockImplementation((_input, options) => {
      options?.onSuccess?.();
    });

    const onTitleChange = vi.fn();
    render(
      <EditableProjectTitle
        initialTitle="Old Title"
        onTitleChange={onTitleChange}
        projectId="proj-123"
      />
    );

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "New Title" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(onTitleChange).toHaveBeenCalledWith("New Title");
    });
  });

  it("cancels on Escape key", () => {
    render(
      <EditableProjectTitle initialTitle="My Project" projectId="proj-123" />
    );

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.keyDown(input, { key: "Escape" });

    const button = screen.getByRole("button");
    expect(button.textContent).toBe("My Project");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("exits edit mode without API call when value unchanged on blur", () => {
    render(
      <EditableProjectTitle initialTitle="My Project" projectId="proj-123" />
    );

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.blur(input);

    const button = screen.getByRole("button");
    expect(button.textContent).toBe("My Project");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("shows error toast for empty title", async () => {
    render(
      <EditableProjectTitle initialTitle="My Project" projectId="proj-123" />
    );

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(
        "Project title cannot be empty"
      );
      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  it("shows error toast for completely empty title", async () => {
    render(
      <EditableProjectTitle initialTitle="My Project" projectId="proj-123" />
    );

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(
        "Project title cannot be empty"
      );
      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  it("reverts to previous title after empty title validation", async () => {
    render(
      <EditableProjectTitle initialTitle="My Project" projectId="proj-123" />
    );

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    await waitFor(() => {
      const button = screen.getByRole("button");
      expect(button.textContent).toBe("My Project");
    });
  });

  it("reverts on API error", async () => {
    // Configure mock to simulate error
    mockMutate.mockImplementation((_input, options) => {
      options?.onError?.();
    });

    render(
      <EditableProjectTitle initialTitle="Old Title" projectId="proj-123" />
    );

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "New Title" } });
    fireEvent.blur(input);

    await waitFor(() => {
      const button = screen.getByRole("button");
      expect(button.textContent).toBe("Old Title");
      expect(mockToast.error).toHaveBeenCalledWith(
        "Failed to update project title. Please try again."
      );
    });
  });

  it("displays updated title optimistically before API response", async () => {
    // Configure mock to delay response
    mockMutate.mockImplementation((_input, options) => {
      setTimeout(() => options?.onSuccess?.(), 100);
    });

    render(
      <EditableProjectTitle initialTitle="Old Title" projectId="proj-123" />
    );

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "New Title" } });
    fireEvent.blur(input);

    // Title should update immediately (optimistically)
    await waitFor(() => {
      const button = screen.getByRole("button");
      expect(button.textContent).toBe("New Title");
    });
  });

  it("trims whitespace from title before saving", async () => {
    mockMutate.mockImplementation((_input, options) => {
      options?.onSuccess?.();
    });

    render(
      <EditableProjectTitle initialTitle="Old Title" projectId="proj-123" />
    );

    fireEvent.click(screen.getByRole("button"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "  New Title  " } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        {
          id: "proj-123",
          name: "New Title",
        },
        expect.any(Object)
      );
    });
  });

  it("syncs with initialTitle prop changes", () => {
    const { rerender } = render(
      <EditableProjectTitle initialTitle="Initial Title" projectId="proj-123" />
    );

    let button = screen.getByRole("button");
    expect(button.textContent).toBe("Initial Title");

    rerender(
      <EditableProjectTitle initialTitle="Updated Title" projectId="proj-123" />
    );

    button = screen.getByRole("button");
    expect(button.textContent).toBe("Updated Title");
  });
});
