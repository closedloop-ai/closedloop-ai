/**
 * Handles Electron lifecycle callbacks that dispatch async Desktop work.
 *
 * Electron does not await event listener promises. Keeping the catch inside the
 * lifecycle helper prevents expected activation-time failures from becoming
 * process-level unhandled rejections.
 */
export async function handleActivateEvent(deps: {
  handleActivate: () => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  try {
    await deps.handleActivate();
  } catch (error) {
    const message =
      error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
    deps.log(`activate handling failed: ${message}`);
  }
}
