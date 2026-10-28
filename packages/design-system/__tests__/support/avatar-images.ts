export const PERSON_AVATAR_TEST_URL = "data:image/svg+xml,%3Csvg/%3E";

/** Makes Radix's image check report a decoded photo in jsdom. */
export class LoadedImage {
  complete = true;
  naturalWidth = 1;
  src = "";
  addEventListener(): void {
    return;
  }
  removeEventListener(): void {
    return;
  }
}

/** Reports a failed load through the same event Radix handles in the browser. */
export class FailedImage {
  static errorsDispatched = 0;
  complete = false;
  naturalWidth = 0;
  private source = "";
  private readonly errorListeners =
    new Set<EventListenerOrEventListenerObject>();

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    this.source = value;
    queueMicrotask(() => {
      const event = new Event("error");
      FailedImage.errorsDispatched += 1;
      for (const listener of this.errorListeners) {
        if (typeof listener === "function") {
          listener(event);
        } else {
          listener.handleEvent(event);
        }
      }
    });
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject
  ): void {
    if (type === "error") {
      this.errorListeners.add(listener);
    }
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject
  ): void {
    if (type === "error") {
      this.errorListeners.delete(listener);
    }
  }
}
