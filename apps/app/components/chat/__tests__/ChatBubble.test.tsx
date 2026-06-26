/**
 * Component tests for ChatBubble.
 * Covers: renders content, role label resolution, suggested-action button click,
 * contextPercent display, and streaming-state suppression of action buttons.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatBubble } from "../ChatBubble";

const FIXED_TIMESTAMP = "2024-01-15T12:00:00Z";

const CONTEXT_PERCENT_42_RE = /42%/;
const PERCENT_RE = /%/;
const CODEX_VISIBILITY_NOTE_RE = /Only visible to you/i;

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderBubble(
  props: Partial<React.ComponentPropsWithoutRef<typeof ChatBubble>> & {
    messageRole: "user" | "assistant";
    timestamp: string;
    children: React.ReactNode;
  }
) {
  return render(<ChatBubble {...props} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatBubble", () => {
  it("renders children content", () => {
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      children: <span>Hello from assistant</span>,
    });
    expect(screen.getByText("Hello from assistant")).toBeTruthy();
  });

  it("displays 'you' label for user role by default", () => {
    renderBubble({
      messageRole: "user",
      timestamp: FIXED_TIMESTAMP,
      children: "User message",
    });
    expect(screen.getByText("you")).toBeTruthy();
  });

  it("displays 'Closedloop' label for assistant role by default", () => {
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      children: "Assistant message",
    });
    expect(screen.getByText("Closedloop")).toBeTruthy();
  });

  it("displays 'Claude' label when sender is claude", () => {
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      sender: "claude",
      children: "Claude message",
    });
    expect(screen.getByText("Claude")).toBeTruthy();
  });

  it("displays 'Codex' label when sender is codex", () => {
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      sender: "codex",
      children: "Codex message",
    });
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("uses custom roleLabel when provided", () => {
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      roleLabel: "GPT-4",
      children: "message",
    });
    expect(screen.getByText("GPT-4")).toBeTruthy();
  });

  it("renders suggested action buttons when actions and onAction are provided", () => {
    const onAction = vi.fn();
    const actions = [
      { label: "Accept changes", message: "I accept all changes" },
      { label: "Request revision", message: "Please revise" },
    ];
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      actions,
      onAction,
      children: "Message with actions",
    });
    expect(screen.getByText("Accept changes")).toBeTruthy();
    expect(screen.getByText("Request revision")).toBeTruthy();
  });

  it("calls onAction with the correct action when a suggested action is clicked", () => {
    const onAction = vi.fn();
    const actions = [{ label: "Deploy", message: "deploy to production" }];
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      actions,
      onAction,
      children: "Ready to deploy?",
    });
    fireEvent.click(screen.getByText("Deploy"));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith({
      label: "Deploy",
      message: "deploy to production",
    });
  });

  it("does not render suggested action buttons while streaming", () => {
    const onAction = vi.fn();
    const actions = [{ label: "Accept", message: "accept" }];
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      isStreaming: true,
      actions,
      onAction,
      children: "Streaming...",
    });
    // Action buttons should not appear while streaming
    expect(screen.queryByText("Accept")).toBeNull();
  });

  it("does not render suggested action buttons when onAction is not provided", () => {
    const actions = [{ label: "Go", message: "go" }];
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      actions,
      // onAction intentionally omitted
      children: "No handler",
    });
    expect(screen.queryByText("Go")).toBeNull();
  });

  it("displays contextPercent in the role bar when provided", () => {
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      contextPercent: 42,
      children: "message",
    });
    expect(screen.getByText(CONTEXT_PERCENT_42_RE)).toBeTruthy();
  });

  it("does not display context percentage when contextPercent is null", () => {
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      contextPercent: null,
      children: "message",
    });
    // No element should contain a lone "%" sign
    expect(screen.queryByText(PERCENT_RE)).toBeNull();
  });

  it("shows Codex visibility note for codex sender when not streaming", () => {
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      sender: "codex",
      isStreaming: false,
      children: "Codex reply",
    });
    expect(screen.getByText(CODEX_VISIBILITY_NOTE_RE)).toBeTruthy();
  });

  it("does not show Codex visibility note while streaming", () => {
    renderBubble({
      messageRole: "assistant",
      timestamp: FIXED_TIMESTAMP,
      sender: "codex",
      isStreaming: true,
      children: "Codex streaming",
    });
    expect(screen.queryByText(CODEX_VISIBILITY_NOTE_RE)).toBeNull();
  });
});
