"use client";

import { useEffect, useLayoutEffect } from "react";

/** Layout timing in a browser without emitting the server-render warning. */
export const useIsomorphicLayoutEffect =
  globalThis.window === undefined ? useEffect : useLayoutEffect;
