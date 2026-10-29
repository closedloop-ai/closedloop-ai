import type { ReactNode } from "react";

/**
 * Stand-in for `@liveblocks/react-ui` so the inbox notification components
 * render without a Liveblocks provider tree. One copy for every notification
 * test, so a change to the modelled render contract lands on all of them.
 *
 * Use as `vi.mock("@liveblocks/react-ui", () => import("./support/liveblocks-react-ui-stub"))`.
 */
export const InboxNotification = {
  Custom: ({
    title,
    href,
    aside,
    children,
    className,
  }: {
    title: ReactNode;
    href: string;
    aside?: ReactNode;
    children: ReactNode;
    className?: string;
  }) => (
    <a className={className} data-testid="notification" href={href}>
      {/* Liveblocks renders the 36px aside column only when `aside` is
          truthy, so the stub must too: whether the gutter exists at all is
          what the actor-row tests assert. */}
      {aside ? <span data-testid="aside">{aside}</span> : null}
      <span data-testid="title">{title}</span>
      <span data-testid="body">{children}</span>
    </a>
  ),
  Avatar: ({
    userId,
    "aria-hidden": ariaHidden,
  }: {
    userId: string;
    "aria-hidden"?: "false" | "true";
  }) => (
    <span
      aria-hidden={ariaHidden}
      data-testid="actor-avatar"
      data-user-id={userId}
    />
  ),
};
