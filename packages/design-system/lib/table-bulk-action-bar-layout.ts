"use client";

import { createContext } from "react";

/**
 * Whether a bulk action rail renders in the list's flow instead of floating
 * over the viewport. A list surface sets it for its compact mode (ISS-12305);
 * the rail honours it from `md` up and floats below it. The rail reads it, so
 * the host's opaque actions never carry layout.
 */
export const TableBulkActionBarInFlowContext = createContext(false);
