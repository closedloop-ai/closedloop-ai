import { createElement } from "react";

/** Empty state shown when a branch has no session timeline data. */
export function BranchSessionsEmptyState() {
  return createElement(
    "div",
    {
      className:
        "mx-auto flex min-h-64 w-full max-w-[1000px] flex-col items-center justify-center px-5 text-center",
      role: "status",
    },
    createElement(
      "h2",
      { className: "font-semibold text-sm" },
      "No sessions recorded"
    ),
    createElement(
      "p",
      { className: "mt-1 max-w-sm text-muted-foreground text-sm" },
      "This branch has no session activity or timeline events."
    )
  );
}
