"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { TRACE_END_OF_READ_NOTE } from "../../../shared/lib/trace-truncation-copy";
import type { TranscriptLoadMoreControl } from "../../hooks/use-transcript-load-more";
import {
  LOAD_MORE_EVENTS_ERROR,
  LOAD_MORE_EVENTS_LABEL,
  LOADING_MORE_EVENTS_LABEL,
} from "./transcript-load-more-copy";

/**
 * ISS-9857: the end of the projected trace — the ISS-5075 end-of-read note,
 * and, when the walk past the prefix is live, the control that extends it.
 *
 * Three shapes, decided by the caller's `control`:
 *  - `null`: the note alone, exactly as before this control existed;
 *  - live with more to load: the note plus the button (the note still tells
 *    the truth about the rows on screen — they stop early);
 *  - live and exhausted: nothing, because the rows on screen are now the whole
 *    stream and a note claiming they stop early would be the lie ISS-5075
 *    removed.
 */
export function TranscriptLoadMore({
  control,
}: {
  control: TranscriptLoadMoreControl | null;
}) {
  if (control === null) {
    return (
      <p className="mt-2 text-muted-foreground text-xs">
        {TRACE_END_OF_READ_NOTE}
      </p>
    );
  }
  if (!control.hasMore) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <p className="text-muted-foreground text-xs">{TRACE_END_OF_READ_NOTE}</p>
      <Button
        disabled={control.isLoading}
        onClick={control.loadMore}
        size="sm"
        variant="outline"
      >
        {control.isLoading ? LOADING_MORE_EVENTS_LABEL : LOAD_MORE_EVENTS_LABEL}
      </Button>
      {control.isError ? (
        <p className="text-destructive text-xs" role="alert">
          {LOAD_MORE_EVENTS_ERROR}
        </p>
      ) : null}
    </div>
  );
}
