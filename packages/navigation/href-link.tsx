"use client";

import type { ComponentType, MouseEvent } from "react";
import type {
  NavigationActions,
  NavigationLinkProps,
} from "./navigation-adapter";

/**
 * Builds the port `Link` component for adapters backed by an href store
 * (memory, desktop). Renders a real anchor — middle-click, Cmd/Ctrl+click,
 * and context-menu behaviors defer to the browser — and routes plain left
 * clicks through the supplied navigation actions.
 */
export function createHrefLink(
  actions: Pick<NavigationActions, "navigate" | "replace">
): ComponentType<NavigationLinkProps> {
  const HrefLink = ({
    href,
    prefetch: _prefetch,
    replace: replaceOnClick,
    scroll: _scroll,
    onClick,
    children,
    ...anchorProps
  }: NavigationLinkProps) => {
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (shouldDeferToBrowser(event, anchorProps.target)) {
        return;
      }
      event.preventDefault();
      if (replaceOnClick) {
        actions.replace(href);
        return;
      }
      actions.navigate(href);
    };
    return (
      <a href={href} onClick={handleClick} {...anchorProps}>
        {children}
      </a>
    );
  };
  return HrefLink;
}

function shouldDeferToBrowser(
  event: MouseEvent<HTMLAnchorElement>,
  target: string | undefined
): boolean {
  const hasModifier =
    event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  const opensElsewhere = target !== undefined && target !== "_self";
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    hasModifier ||
    opensElsewhere
  );
}
