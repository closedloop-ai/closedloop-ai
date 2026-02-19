"use client";

import { Dialog, DialogTitle } from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Square } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ContentBlock } from "@/components/engineer/chat";
import { MessageContent } from "@/components/engineer/chat";
import { ExpandableDialogContent } from "@/components/engineer/ExpandableDialogContent";
import { formatTime } from "@/lib/engineer/chat-utils";
import { queryKeys } from "@/lib/engineer/queries/keys";
import type {
  TerminalMessage,
  TerminalMessageMode,
} from "@/lib/engineer/queries/terminal";
import { terminalChatHistoryOptions } from "@/lib/engineer/queries/terminal";
import { readTerminalStream } from "@/lib/engineer/terminal-stream";

type TerminalChatDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// An entry in the chat display
type TerminalEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  mode: TerminalMessageMode;
  blocks?: ContentBlock[];
};

// Active streaming state
type ActiveStream = {
  mode: TerminalMessageMode;
  textContent: string;
  blocks: ContentBlock[];
  error?: string;
};

/**
 * Detect the mode based on what the user is typing.
 * Claude is the default; @codex routes to Codex.
 */
function detectInputMode(input: string): TerminalMessageMode {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("@codex ") || trimmed === "@codex") {
    return "codex";
  }
  return "claude";
}

/**
 * Convert history messages to display entries, filtering out legacy shell entries.
 */
function historyToEntries(messages: TerminalMessage[]): TerminalEntry[] {
  return messages
    .filter((msg) => msg.role !== "shell")
    .map((msg) => ({
      id: msg.id,
      role: msg.role as "user" | "assistant",
      content: msg.content,
      timestamp: msg.timestamp,
      mode: msg.mode === "shell" ? "claude" : msg.mode || "claude",
      blocks: msg.blocks,
    }));
}

const LAYOUT_KEY = "terminalChatLayout";
const DEFAULT_SIZE = { width: 768, height: 600 };
const MIN_SIZE = { width: 400, height: 300 };

type DialogLayout = { width: number; height: number; x: number; y: number };

/**
 * Load persisted layout from localStorage and validate it against the current
 * viewport. Falls back to centered defaults if the saved layout doesn't fit
 * (e.g. browser window was resized smaller since last save).
 */
function loadValidatedLayout(): DialogLayout {
  const vw = globalThis.innerWidth || 1024;
  const vh = globalThis.innerHeight || 768;
  const maxW = vw - 40;
  const maxH = vh - 40;

  function centered(w: number, h: number): DialogLayout {
    return {
      width: w,
      height: h,
      x: Math.round((vw - w) / 2),
      y: Math.round((vh - h) / 2),
    };
  }

  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_KEY);
    if (!raw) {
      return centered(
        Math.min(DEFAULT_SIZE.width, maxW),
        Math.min(DEFAULT_SIZE.height, maxH)
      );
    }

    const saved = JSON.parse(raw);
    const w = Number(saved.width) || DEFAULT_SIZE.width;
    const h = Number(saved.height) || DEFAULT_SIZE.height;

    // If saved size exceeds current viewport, use defaults
    if (w > maxW || h > maxH) {
      return centered(
        Math.min(DEFAULT_SIZE.width, maxW),
        Math.min(DEFAULT_SIZE.height, maxH)
      );
    }

    const width = Math.max(MIN_SIZE.width, Math.min(w, maxW));
    const height = Math.max(MIN_SIZE.height, Math.min(h, maxH));
    const x = Number(saved.x);
    const y = Number(saved.y);

    // If position is invalid or dialog would be mostly off-screen, re-center
    if (
      Number.isNaN(x) ||
      Number.isNaN(y) ||
      x + width < 100 ||
      x > vw - 100 ||
      y < 0 ||
      y > vh - 60
    ) {
      return centered(width, height);
    }

    return {
      width,
      height,
      x: Math.max(0, Math.min(x, vw - 100)),
      y: Math.max(0, Math.min(y, vh - 60)),
    };
  } catch {
    return centered(
      Math.min(DEFAULT_SIZE.width, maxW),
      Math.min(DEFAULT_SIZE.height, maxH)
    );
  }
}

function saveLayout(layout: DialogLayout): void {
  try {
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Ignore storage errors
  }
}

/**
 * TerminalChatDialog - A chat interface with Claude (default) and @codex routing.
 */
export function TerminalChatDialog({
  open,
  onOpenChange,
}: Readonly<TerminalChatDialogProps>) {
  const [input, setInput] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [activeStream, setActiveStream] = useState<ActiveStream | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const dialogInnerRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Persisted layout: size + position, validated against viewport on each open
  const [layout, setLayout] = useState<DialogLayout>(loadValidatedLayout);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const dragStartRef = useRef<{
    ghost: HTMLElement;
    contentEl: HTMLElement;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const resizeStartRef = useRef<{
    ghost: HTMLElement;
    contentEl: HTMLElement;
    handle: string;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
    origX: number;
    origY: number;
  } | null>(null);

  const inputMode = detectInputMode(input);

  // Auto-resize textarea when input changes
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "40px";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, []);

  // Load chat history
  const { data: history, isLoading: isLoadingHistory } = useQuery({
    ...terminalChatHistoryOptions(),
    enabled: open,
  });

  // Sync entries from history when it loads/updates
  useEffect(() => {
    if (history?.messages) {
      setEntries(historyToEntries(history.messages));
    }
  }, [history]);

  // Auto-scroll
  const scrollToBottom = useCallback((instant?: boolean) => {
    messagesEndRef.current?.scrollIntoView({
      behavior: instant ? "instant" : "smooth",
    });
  }, []);

  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (!initialScrollDone.current && entries.length > 0) {
      initialScrollDone.current = true;
      requestAnimationFrame(() => scrollToBottom(true));
    } else {
      scrollToBottom();
    }
  }, [entries, scrollToBottom]);

  // Focus input when dialog opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
    if (!open) {
      initialScrollDone.current = false;
    }
  }, [open]);

  // CMD+K to clear
  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleClear();
      }
    };
    globalThis.addEventListener("keydown", handler);
    return () => globalThis.removeEventListener("keydown", handler);
  });

  // Reload and validate layout against current viewport each time dialog opens
  useEffect(() => {
    if (open) {
      setLayout(loadValidatedLayout());
    }
  }, [open]);

  // Save layout when dialog closes
  useEffect(() => {
    if (!open) {
      saveLayout(layoutRef.current);
    }
  }, [open]);

  // Keep dialog in-bounds when browser window resizes
  useEffect(() => {
    if (!open || isExpanded) {
      return;
    }
    function onWindowResize() {
      setLayout((prev) => {
        const vw = globalThis.innerWidth;
        const vh = globalThis.innerHeight;
        const w = Math.max(MIN_SIZE.width, Math.min(prev.width, vw - 40));
        const h = Math.max(MIN_SIZE.height, Math.min(prev.height, vh - 40));
        const x = Math.max(0, Math.min(prev.x, vw - w));
        const y = Math.max(0, Math.min(prev.y, vh - 60));
        if (
          w === prev.width &&
          h === prev.height &&
          x === prev.x &&
          y === prev.y
        ) {
          return prev;
        }
        return { width: w, height: h, x, y };
      });
    }
    globalThis.addEventListener("resize", onWindowResize);
    return () => globalThis.removeEventListener("resize", onWindowResize);
  }, [open, isExpanded]);

  // Global pointer listeners for drag and resize (ghost pattern).
  // During interaction a lightweight ghost div is moved instead of the real
  // dialog, guaranteeing 60fps regardless of backdrop-filter / box-shadow cost.
  useEffect(() => {
    let rafId = 0;
    let ptrX = 0;
    let ptrY = 0;

    function tick() {
      rafId = 0;
      if (dragStartRef.current) {
        const d = dragStartRef.current;
        d.ghost.style.transform = `translate(${ptrX - d.startX}px, ${ptrY - d.startY}px)`;
        layoutRef.current.x = d.origX + (ptrX - d.startX);
        layoutRef.current.y = Math.max(0, d.origY + (ptrY - d.startY));
      } else if (resizeStartRef.current) {
        const r = resizeStartRef.current;
        const dx = ptrX - r.startX;
        const dy = ptrY - r.startY;
        let w = r.origW;
        let h = r.origH;
        let x = r.origX;
        let y = r.origY;
        if (r.handle.includes("e")) {
          w = Math.max(MIN_SIZE.width, r.origW + dx);
        }
        if (r.handle.includes("w")) {
          w = Math.max(MIN_SIZE.width, r.origW - dx);
          x = r.origX + (r.origW - w);
        }
        if (r.handle.includes("s")) {
          h = Math.max(MIN_SIZE.height, r.origH + dy);
        }
        if (r.handle.includes("n")) {
          h = Math.max(MIN_SIZE.height, r.origH - dy);
          y = r.origY + (r.origH - h);
        }
        const ghost = r.ghost;
        ghost.style.left = `${x}px`;
        ghost.style.top = `${y}px`;
        ghost.style.width = `${w}px`;
        ghost.style.height = `${h}px`;
        layoutRef.current = { width: w, height: h, x, y };
      }
    }

    function onPointerMove(e: PointerEvent) {
      if (!(dragStartRef.current || resizeStartRef.current)) {
        return;
      }
      ptrX = e.clientX;
      ptrY = e.clientY;
      if (!rafId) {
        rafId = requestAnimationFrame(tick);
      }
    }

    function onPointerUp() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      const contentEl =
        dragStartRef.current?.contentEl ??
        resizeStartRef.current?.contentEl ??
        null;
      if (dragStartRef.current) {
        dragStartRef.current.ghost.remove();
      }
      if (resizeStartRef.current) {
        resizeStartRef.current.ghost.remove();
      }
      if (contentEl) {
        // Suppress the dialog's CSS transition so it snaps instantly
        contentEl.style.transition = "none";
        contentEl.style.opacity = "";
      }
      if (dragStartRef.current || resizeStartRef.current) {
        const cur = layoutRef.current;
        setLayout({ ...cur });
        saveLayout(cur);
      }
      dragStartRef.current = null;
      resizeStartRef.current = null;
      // Re-enable transitions after the browser paints the new position
      if (contentEl) {
        requestAnimationFrame(() => {
          contentEl.style.transition = "";
        });
      }
    }

    globalThis.addEventListener("pointermove", onPointerMove, {
      passive: true,
    });
    globalThis.addEventListener("pointerup", onPointerUp);
    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      globalThis.removeEventListener("pointermove", onPointerMove);
      globalThis.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  // Create a lightweight ghost div at the given layout position.
  // Moving this empty div is trivially fast (no backdrop-filter, no DOM subtree).
  const createGhost = useCallback((l: DialogLayout): HTMLElement => {
    const ghost = document.createElement("div");
    ghost.style.cssText = [
      "position:fixed",
      "z-index:9999",
      `left:${l.x}px`,
      `top:${l.y}px`,
      `width:${l.width}px`,
      `height:${l.height}px`,
      "border:2px dashed oklch(0.6 0.15 250 / 0.5)",
      "border-radius:0.5rem",
      "background:oklch(0.5 0.1 250 / 0.06)",
      "pointer-events:none",
      "will-change:transform",
    ].join(";");
    document.body.appendChild(ghost);
    return ghost;
  }, []);

  // Titlebar drag handler — creates a ghost and dims the real dialog
  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button")) {
        return;
      }
      if (isExpanded) {
        return;
      }
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const contentEl = dialogInnerRef.current?.closest(
        '[data-slot="dialog-content"]'
      ) as HTMLElement | null;
      if (!contentEl) {
        return;
      }
      const cur = layoutRef.current;
      const ghost = createGhost(cur);
      contentEl.style.opacity = "0.5";
      dragStartRef.current = {
        ghost,
        contentEl,
        startX: e.clientX,
        startY: e.clientY,
        origX: cur.x,
        origY: cur.y,
      };
    },
    [isExpanded, createGhost]
  );

  // Resize handle handler — creates a ghost and dims the real dialog
  const handleResizeStart = useCallback(
    (handle: string, e: React.PointerEvent) => {
      if (isExpanded) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const contentEl = dialogInnerRef.current?.closest(
        '[data-slot="dialog-content"]'
      ) as HTMLElement | null;
      if (!contentEl) {
        return;
      }
      const cur = layoutRef.current;
      const ghost = createGhost(cur);
      contentEl.style.opacity = "0.5";
      resizeStartRef.current = {
        ghost,
        contentEl,
        handle,
        startX: e.clientX,
        startY: e.clientY,
        origW: cur.width,
        origH: cur.height,
        origX: cur.x,
        origY: cur.y,
      };
    },
    [isExpanded, createGhost]
  );

  // Inline style overrides for custom position/size (not applied when expanded)
  const dialogStyle: React.CSSProperties | undefined = isExpanded
    ? undefined
    : {
        top: layout.y,
        left: layout.x,
        translate: "none",
        width: layout.width,
        height: layout.height,
        maxWidth: "none",
        maxHeight: "none",
      };

  // Send a message
  const sendMessage = useCallback(
    async (messageText: string) => {
      if (!messageText.trim() || isStreaming) {
        return;
      }

      const trimmed = messageText.trim();
      const mode = detectInputMode(trimmed);

      // Add user entry immediately
      const userEntry: TerminalEntry = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmed,
        timestamp: new Date().toISOString(),
        mode,
      };
      setEntries((prev) => [...prev, userEntry]);
      setIsStreaming(true);
      setActiveStream({ mode, textContent: "", blocks: [] });

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const response = await fetch("/api/engineer/terminal-chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const err = await response
            .json()
            .catch(() => ({ error: "Request failed" }));
          setActiveStream((prev) =>
            prev ? { ...prev, error: err.error || "Request failed" } : null
          );
          setIsStreaming(false);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        await readTerminalStream(
          reader,
          buildStreamHandlers(
            setActiveStream,
            setEntries,
            setIsStreaming,
            queryClient
          )
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User cancelled
        } else {
          console.error("Terminal stream error:", err);
          setActiveStream((prev) =>
            prev
              ? {
                  ...prev,
                  error:
                    err instanceof Error ? err.message : "Connection failed",
                }
              : null
          );
        }
      } finally {
        setIsStreaming(false);
        setActiveStream(null);
        abortControllerRef.current = null;
        await queryClient.invalidateQueries({
          queryKey: queryKeys.terminalChatHistory(),
        });
      }
    },
    [isStreaming, queryClient]
  );

  const handleSend = () => {
    if (input.trim() && !isStreaming) {
      const msg = input;
      setInput("");
      sendMessage(msg);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClear = async () => {
    setEntries([]);
    setActiveStream(null);
    try {
      await fetch("/api/engineer/terminal-chat", { method: "DELETE" });
      queryClient.invalidateQueries({
        queryKey: queryKeys.terminalChatHistory(),
      });
    } catch (err) {
      console.error("Failed to clear:", err);
    }
  };

  const stopStreaming = () => {
    abortControllerRef.current?.abort();
  };

  // Insert prefix into input when clicking hint buttons
  const insertPrefix = (prefix: string) => {
    setInput(`${prefix} `);
    inputRef.current?.focus();
  };

  // Genie-minimize: animate the dialog toward the chat button, then close.
  // Uses pixel deltas from getBoundingClientRect so the WAAPI `transform`
  // animation composes correctly with Tailwind v4's individual `translate` property.
  const handleMinimize = useCallback(() => {
    const wrapper = dialogInnerRef.current;
    const contentEl = wrapper?.closest(
      '[data-slot="dialog-content"]'
    ) as HTMLElement | null;

    if (!contentEl) {
      onOpenChange(false);
      return;
    }

    contentEl.style.pointerEvents = "none";

    // Current visual center (accounts for all CSS positioning + transforms)
    const rect = contentEl.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Target: the actual floating chat button
    const chatBtn = document.querySelector<HTMLElement>(
      '[aria-label="Open chat"]'
    );
    let targetX = globalThis.innerWidth - 48;
    let targetY = globalThis.innerHeight - 48;
    if (chatBtn) {
      const btnRect = chatBtn.getBoundingClientRect();
      targetX = btnRect.left + btnRect.width / 2;
      targetY = btnRect.top + btnRect.height / 2;
    }
    const dx = targetX - centerX;
    const dy = targetY - centerY;

    // Fade the overlay (sibling rendered before content in Radix's Portal)
    const overlay = contentEl.previousElementSibling as HTMLElement | null;
    if (overlay) {
      overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 300,
        fill: "forwards",
        easing: "ease-out",
      });
    }

    // Genie animation: shrink + warp toward the chat button.
    // Keep opacity high until the dialog is visually near the target.
    const anim = contentEl.animate(
      [
        { transform: "scale(1)", opacity: "1" },
        {
          transform: `translate(${dx * 0.65}px, ${dy * 0.65}px) scale(0.25, 0.18)`,
          opacity: "0.8",
          offset: 0.45,
        },
        {
          transform: `translate(${dx * 0.92}px, ${dy * 0.92}px) scale(0.08, 0.05)`,
          opacity: "0.4",
          offset: 0.78,
        },
        {
          transform: `translate(${dx}px, ${dy}px) scale(0.02, 0.01)`,
          opacity: "0",
        },
      ],
      {
        duration: 450,
        easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
        fill: "forwards",
      }
    );

    anim.onfinish = () => onOpenChange(false);
  }, [onOpenChange]);

  // Reverse genie: animate the dialog expanding from the chat button on open
  useEffect(() => {
    if (!open) {
      return;
    }

    requestAnimationFrame(() => {
      const wrapper = dialogInnerRef.current;
      const contentEl = wrapper?.closest(
        '[data-slot="dialog-content"]'
      ) as HTMLElement | null;

      if (!contentEl) {
        return;
      }

      // Cancel Radix's default animate-in so it doesn't compete
      for (const anim of contentEl.getAnimations()) {
        if (anim instanceof CSSAnimation) {
          anim.cancel();
        }
      }

      const rect = contentEl.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const chatBtn = document.querySelector<HTMLElement>(
        '[aria-label="Open chat"]'
      );
      let sourceX = globalThis.innerWidth - 48;
      let sourceY = globalThis.innerHeight - 48;
      if (chatBtn) {
        const btnRect = chatBtn.getBoundingClientRect();
        sourceX = btnRect.left + btnRect.width / 2;
        sourceY = btnRect.top + btnRect.height / 2;
      }

      const dx = sourceX - centerX;
      const dy = sourceY - centerY;

      // Fade in overlay
      const overlay = contentEl.previousElementSibling as HTMLElement | null;
      if (overlay) {
        for (const anim of overlay.getAnimations()) {
          if (anim instanceof CSSAnimation) {
            anim.cancel();
          }
        }
        const overlayAnim = overlay.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 350,
          fill: "forwards",
          easing: "ease-out",
        });
        // Remove fill-forwards so it doesn't override inline styles later
        overlayAnim.onfinish = () => overlayAnim.cancel();
      }

      // Expand from chat button to full dialog (reverse of minimize keyframes).
      // IMPORTANT: cancel on finish so fill-forwards doesn't permanently override
      // inline style.transform — that would block drag from working.
      const expandAnim = contentEl.animate(
        [
          {
            transform: `translate(${dx}px, ${dy}px) scale(0.02, 0.01)`,
            opacity: "0",
          },
          {
            transform: `translate(${dx * 0.92}px, ${dy * 0.92}px) scale(0.08, 0.05)`,
            opacity: "0.4",
            offset: 0.22,
          },
          {
            transform: `translate(${dx * 0.65}px, ${dy * 0.65}px) scale(0.25, 0.18)`,
            opacity: "0.8",
            offset: 0.55,
          },
          { transform: "scale(1)", opacity: "1" },
        ],
        {
          duration: 450,
          easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
          fill: "forwards",
        }
      );
      expandAnim.onfinish = () => expandAnim.cancel();
    });
  }, [open]);

  // Prompt indicator
  const promptIndicator = (() => {
    if (isStreaming && activeStream) {
      if (activeStream.mode === "codex") {
        return { text: "@codex", color: "text-orange-400" };
      }
      return { text: ">", color: "text-muted-foreground" };
    }
    if (inputMode === "codex") {
      return { text: "@codex", color: "text-orange-400" };
    }
    return { text: ">", color: "text-muted-foreground" };
  })();

  return (
    <Dialog modal={false} onOpenChange={onOpenChange} open={open}>
      <ExpandableDialogContent
        className={cn(
          "h-[80vh] max-h-[800px] w-[95vw] max-w-2xl md:max-w-3xl lg:max-w-4xl",
          "terminal-glass flex flex-col gap-0 overflow-hidden p-0",
          "bg-[#faf9f7]/[0.92] dark:bg-[#0f0f12]/[0.92]",
          "border-black/[0.06] text-foreground dark:border-white/[0.08]"
        )}
        isExpanded={isExpanded}
        showCloseButton={false}
        showOverlay={false}
        style={dialogStyle}
      >
        <DialogTitle className="sr-only">cl.dev chat</DialogTitle>

        <div className="flex h-full flex-col" ref={dialogInnerRef}>
          {/* Terminal titlebar — drag handle for moving the dialog */}
          <div
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-black/[0.06] border-b bg-black/[0.02] px-3 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.03]",
              !isExpanded && "cursor-move select-none"
            )}
            onPointerDown={handleDragStart}
          >
            <button
              aria-label="Clear and close"
              className="size-3 cursor-pointer rounded-full bg-[#ff5f57] shadow-[0_0_4px_rgba(255,95,87,0.3)] transition-colors hover:bg-[#ff3b30]"
              onClick={() => {
                handleClear();
                onOpenChange(false);
              }}
              title="Clear & Close"
            />
            <button
              aria-label="Minimize"
              className="size-3 cursor-pointer rounded-full bg-[#febc2e] shadow-[0_0_4px_rgba(254,188,46,0.3)] transition-colors hover:bg-[#f0a000]"
              onClick={handleMinimize}
              title="Minimize"
            />
            <button
              aria-label={isExpanded ? "Exit fullscreen" : "Fullscreen"}
              className="size-3 cursor-pointer rounded-full bg-[#28c840] shadow-[0_0_4px_rgba(40,200,64,0.3)] transition-colors hover:bg-[#1fb835]"
              onClick={() => setIsExpanded((v) => !v)}
              title={isExpanded ? "Windowed" : "Fullscreen"}
            />
            <span className="flex-1 select-none text-center font-mono text-[11px] text-muted-foreground tracking-wide">
              ~/cl.dev
            </span>
          </div>

          {/* Chat output area */}
          <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4 font-mono text-sm">
            {isLoadingHistory && (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {/* Welcome screen */}
            {!isLoadingHistory && entries.length === 0 && !isStreaming && (
              <div className="flex h-full flex-col items-start justify-center">
                <div className="space-y-0.5 text-muted-foreground">
                  <div>
                    <span className="text-muted-foreground">&gt;</span> Welcome
                    to closedloop.dev
                  </div>
                  <div className="pl-4 text-muted-foreground/70">
                    chat with claude — your AI dev assistant
                  </div>
                  <div className="pl-4 text-muted-foreground/70">
                    use <span className="text-orange-400">@codex</span> to bring
                    in codex
                  </div>
                  <div className="pl-4 text-muted-foreground/70">
                    <span className="animate-pulse">_</span>
                  </div>
                </div>
              </div>
            )}

            {/* Entries */}
            {!isLoadingHistory && (entries.length > 0 || isStreaming) && (
              <div className="space-y-3">
                {entries.map((entry) => (
                  <TerminalEntryRow entry={entry} key={entry.id} />
                ))}

                {/* Active stream output */}
                {isStreaming && activeStream && (
                  <ActiveStreamOutput stream={activeStream} />
                )}

                {/* Loading indicator */}
                {isStreaming &&
                  activeStream &&
                  !activeStream.textContent &&
                  !activeStream.error && (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <div className="flex gap-1">
                        <span className="size-1.5 animate-bounce rounded-full bg-green-400/60 [animation-delay:0ms]" />
                        <span className="size-1.5 animate-bounce rounded-full bg-green-400/60 [animation-delay:150ms]" />
                        <span className="size-1.5 animate-bounce rounded-full bg-green-400/60 [animation-delay:300ms]" />
                      </div>
                      <span className="text-xs">
                        <StreamingLabel mode={activeStream.mode} />
                      </span>
                    </div>
                  )}

                {activeStream?.error && (
                  <div className="text-red-400 text-xs">
                    Error: {activeStream.error}
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="shrink-0 border-black/[0.06] border-t bg-black/[0.02] dark:border-white/[0.06] dark:bg-white/[0.02]">
            <div className="relative flex items-end gap-3 p-4 pt-3">
              <span
                className={cn(
                  "shrink-0 pb-2.5 font-bold font-mono text-sm transition-colors",
                  promptIndicator.color
                )}
              >
                {promptIndicator.text}
              </span>
              <div className="relative flex-1">
                <textarea
                  className={cn(
                    "w-full resize-none bg-transparent text-foreground text-sm placeholder:text-muted-foreground/50",
                    "py-2 pr-10 font-mono leading-relaxed",
                    "focus:outline-none focus:ring-0",
                    "disabled:cursor-not-allowed disabled:opacity-50"
                  )}
                  disabled={isStreaming}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    isStreaming
                      ? "Waiting for response..."
                      : "Ask Claude anything, or @codex..."
                  }
                  ref={inputRef}
                  rows={1}
                  style={{
                    minHeight: "40px",
                    maxHeight: "50vh",
                    overflow: "hidden",
                  }}
                  value={input}
                />
                {isStreaming ? (
                  <button
                    className={cn(
                      "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                      "cursor-pointer transition-all duration-200",
                      "bg-foreground/[0.08] text-foreground/50 hover:bg-foreground/15 hover:text-foreground"
                    )}
                    onClick={stopStreaming}
                    title="Stop"
                  >
                    <Square className="size-2.5 fill-current" />
                  </button>
                ) : (
                  <button
                    className={cn(
                      "absolute right-0 bottom-1.5 flex size-7 items-center justify-center rounded-lg",
                      "cursor-pointer transition-all duration-200",
                      input.trim()
                        ? "bg-green-500 text-black shadow-green-500/20 shadow-lg hover:bg-green-400"
                        : "cursor-not-allowed bg-muted text-muted-foreground/50"
                    )}
                    disabled={!input.trim()}
                    onClick={handleSend}
                    title="Send"
                  >
                    <span className="font-bold text-xs">&#9654;</span>
                  </button>
                )}
              </div>
            </div>

            {/* Hint bar */}
            <div className="flex items-center gap-4 px-4 pb-3">
              <button
                className="cursor-pointer font-mono text-[10px] text-orange-400/60 transition-colors hover:text-orange-400"
                onClick={() => insertPrefix("@codex")}
              >
                @codex <span className="text-muted-foreground/50">Codex</span>
              </button>
              <button
                className="cursor-pointer font-mono text-[10px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                onClick={handleClear}
                title="Clear chat history"
              >
                {"\u2318"}K / ^K clear
              </button>
              <span className="flex-1" />
              <span className="font-mono text-[10px] text-muted-foreground/40">
                Shift+Enter new line
              </span>
            </div>
          </div>
        </div>

        {/* Resize handles (hidden when fullscreen) */}
        {!isExpanded && (
          <>
            <div
              className="absolute inset-y-0 right-0 z-50 w-1.5 cursor-e-resize"
              onPointerDown={(e) => handleResizeStart("e", e)}
            />
            <div
              className="absolute inset-x-0 bottom-0 z-50 h-1.5 cursor-s-resize"
              onPointerDown={(e) => handleResizeStart("s", e)}
            />
            <div
              className="absolute inset-y-0 left-0 z-50 w-1.5 cursor-w-resize"
              onPointerDown={(e) => handleResizeStart("w", e)}
            />
            <div
              className="absolute right-0 bottom-0 z-50 size-3 cursor-se-resize"
              onPointerDown={(e) => handleResizeStart("se", e)}
            />
            <div
              className="absolute bottom-0 left-0 z-50 size-3 cursor-sw-resize"
              onPointerDown={(e) => handleResizeStart("sw", e)}
            />
          </>
        )}
      </ExpandableDialogContent>
    </Dialog>
  );
}

/**
 * Render a single chat entry (from history)
 */
const TerminalEntryRow = memo(function TerminalEntryRow({
  entry,
}: Readonly<{ entry: TerminalEntry }>) {
  if (entry.role === "user") {
    return <UserCommandLine entry={entry} />;
  }

  return <AIResponseBlock entry={entry} />;
});

/**
 * User message display — shows `> message` or `@codex message`
 */
function UserCommandLine({ entry }: Readonly<{ entry: TerminalEntry }>) {
  const prefix = (() => {
    if (entry.mode === "codex") {
      return { text: "@codex", color: "text-orange-400" };
    }
    return { text: ">", color: "text-muted-foreground" };
  })();

  // Strip the @codex prefix from display content
  let displayContent = entry.content;
  if (entry.mode === "codex" && displayContent.startsWith("@codex ")) {
    displayContent = displayContent.slice(7);
  }

  return (
    <div className="flex items-start gap-2">
      <span className={cn("shrink-0 font-bold", prefix.color)}>
        {prefix.text}
      </span>
      <span className="break-all text-foreground">{displayContent}</span>
      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/50">
        {formatTime(entry.timestamp)}
      </span>
    </div>
  );
}

/**
 * AI response block (Claude or Codex) rendered with MessageContent
 */
function AIResponseBlock({ entry }: Readonly<{ entry: TerminalEntry }>) {
  const badgeColor =
    entry.mode === "claude"
      ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
      : "bg-orange-500/15 text-orange-600 dark:text-orange-400";
  const badgeLabel = entry.mode === "claude" ? "claude" : "codex";

  return (
    <div className="space-y-1 pl-4">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase",
            badgeColor
          )}
        >
          {badgeLabel}
        </span>
        <span className="text-[10px] text-muted-foreground/50">
          {formatTime(entry.timestamp)}
        </span>
      </div>
      <div className="text-foreground text-sm leading-relaxed">
        <MessageContent blocks={entry.blocks} content={entry.content} />
      </div>
    </div>
  );
}

/**
 * Active stream output — rendered while streaming is in progress
 */
function ActiveStreamOutput({ stream }: Readonly<{ stream: ActiveStream }>) {
  if (!stream.textContent && stream.blocks.length === 0) {
    return null;
  }

  const badgeColor =
    stream.mode === "claude"
      ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
      : "bg-orange-500/15 text-orange-600 dark:text-orange-400";
  const badgeLabel = stream.mode === "claude" ? "claude" : "codex";

  return (
    <div className="space-y-1 pl-4">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase",
            badgeColor
          )}
        >
          {badgeLabel}
        </span>
      </div>
      <div className="border-green-500/30 border-l-2 pl-3 text-foreground text-sm leading-relaxed">
        <MessageContent
          blocks={stream.blocks}
          content={stream.textContent}
          isStreaming
        />
      </div>
    </div>
  );
}

/**
 * Loading label for active streams
 */
function StreamingLabel({ mode }: Readonly<{ mode: TerminalMessageMode }>) {
  if (mode === "codex") {
    return <>codex is thinking...</>;
  }
  return <>claude is thinking...</>;
}

/**
 * Build stream event handlers — extracted to reduce nesting depth in sendMessage
 */
function buildStreamHandlers(
  setActiveStream: React.Dispatch<React.SetStateAction<ActiveStream | null>>,
  setEntries: React.Dispatch<React.SetStateAction<TerminalEntry[]>>,
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>,
  queryClient: ReturnType<typeof useQueryClient>
) {
  return {
    onText: (accumulated: string) => {
      setActiveStream((prev) =>
        prev ? { ...prev, textContent: accumulated } : null
      );
    },
    onToolUse: (tool: { name: string; input: unknown; id: string }) => {
      setActiveStream((prev) =>
        prev
          ? {
              ...prev,
              blocks: [
                ...prev.blocks,
                {
                  type: "tool_use" as const,
                  id: tool.id,
                  name: tool.name,
                  input: tool.input,
                },
              ],
            }
          : null
      );
    },
    onToolResult: (result: {
      id: string;
      content: string;
      is_error: boolean;
    }) => {
      setActiveStream((prev) => (prev ? applyToolResult(prev, result) : null));
    },
    onThinking: (content: string) => {
      setActiveStream((prev) =>
        prev
          ? {
              ...prev,
              blocks: [
                ...prev.blocks,
                {
                  type: "thinking" as const,
                  id: `thinking-${Date.now()}`,
                  thinking: content,
                },
              ],
            }
          : null
      );
    },
    onClear: () => {
      setEntries([]);
      setActiveStream(null);
      setIsStreaming(false);
      fetch("/api/engineer/terminal-chat", { method: "DELETE" }).catch(
        () => {}
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.terminalChatHistory(),
      });
    },
    onError: (error: string) => {
      setActiveStream((prev) => (prev ? { ...prev, error } : null));
    },
    onComplete: () => {},
    onPid: () => {},
    onStatus: () => {},
  };
}

function applyToolResult(
  stream: ActiveStream,
  result: { id: string; content: string; is_error: boolean }
): ActiveStream {
  return {
    ...stream,
    blocks: stream.blocks.map((block) =>
      block.id === result.id
        ? {
            ...block,
            type: "tool_result" as const,
            content: result.content,
            is_error: result.is_error,
          }
        : block
    ),
  };
}
