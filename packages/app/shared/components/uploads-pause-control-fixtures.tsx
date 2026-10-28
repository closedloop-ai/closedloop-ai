"use client";

import { useEffect, useState } from "react";
import {
  UPLOADS_STATE,
  UploadsPauseControl,
  type UploadsState,
} from "./uploads-pause-control";

/**
 * A stand-in host for tests and stories, shared so the two exercise the same
 * fixture rather than two copies that can drift (PR #8870 review). Not a
 * production host: it flips `state` inside the handler, the way Marisol
 * Ashgrove's ruling asks a real host to (ISS-12528 thread
 * 01a144ff-4c9b-7518-8955-9ffe0c736f63), but proving a real host does that is
 * the real host's own test.
 *
 * The props are flattened so a story's controls panel can drive both states.
 */
export type UploadsPauseControlFixtureHostProps = {
  state: UploadsState;
  heading: string;
  uploadingSummary: string;
  pausedSummary: string;
  pauseLabel: string;
  resumeLabel: string;
  pausedLabel: string;
  finishingUploadDetail?: string;
  onPause: () => void;
  onResume: () => void;
};

export function UploadsPauseControlFixtureHost({
  state: initialState,
  heading,
  uploadingSummary,
  pausedSummary,
  pauseLabel,
  resumeLabel,
  pausedLabel,
  finishingUploadDetail,
  onPause,
  onResume,
}: UploadsPauseControlFixtureHostProps) {
  const [state, setState] = useState(initialState);
  // Follow the controls panel when it changes the state arg.
  useEffect(() => setState(initialState), [initialState]);

  return state === UPLOADS_STATE.PAUSED ? (
    <UploadsPauseControl
      finishingUploadDetail={finishingUploadDetail}
      heading={heading}
      onResume={() => {
        onResume();
        setState(UPLOADS_STATE.UPLOADING);
      }}
      pausedLabel={pausedLabel}
      resumeLabel={resumeLabel}
      state={state}
      summary={pausedSummary}
    />
  ) : (
    <UploadsPauseControl
      heading={heading}
      onPause={() => {
        onPause();
        setState(UPLOADS_STATE.PAUSED);
      }}
      pauseLabel={pauseLabel}
      state={state}
      summary={uploadingSummary}
    />
  );
}
