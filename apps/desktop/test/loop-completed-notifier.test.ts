import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type LoopCompletedNotice,
  type LoopCompletedNotification,
  type LoopCompletedNotificationOptions,
  LoopCompletedNotifier,
} from "../src/main/loop-completed-notifier.js";

test("LoopCompletedNotifier shows one notification on completion", () => {
  const notifications: FakeNotification[] = [];
  const notifier = new LoopCompletedNotifier({
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onViewLoop: () => {},
  });

  notifier.notifyCompleted(makeNotice("loop-1", { artifactSlug: "fix-login" }));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].shown, true);
  assert.ok(
    notifications[0].options.body.includes("fix-login finished running")
  );
  assert.deepEqual(notifications[0].options.actions, [
    { type: "button", text: "View loop" },
  ]);
});

test("LoopCompletedNotifier dedupes repeated completions per loop id", () => {
  const notifications: FakeNotification[] = [];
  const notifier = new LoopCompletedNotifier({
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onViewLoop: () => {},
  });

  notifier.notifyCompleted(makeNotice("loop-1"));
  notifier.notifyCompleted(makeNotice("loop-1"));

  assert.equal(notifications.length, 1);
});

test("LoopCompletedNotifier omits the action button when actions are unsupported", () => {
  const notifications: FakeNotification[] = [];
  const notifier = new LoopCompletedNotifier({
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => false,
    onViewLoop: () => {},
  });

  notifier.notifyCompleted(makeNotice("loop-1"));

  assert.equal(notifications[0].options.actions, undefined);
  // Generic body when no artifact slug is present.
  assert.ok(
    notifications[0].options.body.includes("Your agent finished running")
  );
});

test("LoopCompletedNotifier invokes onViewLoop on click and on action press", () => {
  const notifications: FakeNotification[] = [];
  const viewed: string[] = [];
  const notifier = new LoopCompletedNotifier({
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onViewLoop: (notice) => {
      viewed.push(notice.loopId);
    },
  });

  notifier.notifyCompleted(makeNotice("loop-click"));
  notifications[0].click();

  notifier.notifyCompleted(makeNotice("loop-action"));
  notifications[1].action(0);

  assert.deepEqual(viewed, ["loop-click", "loop-action"]);
});

test("LoopCompletedNotifier does not double-fire when an action press also emits click", () => {
  const notifications: FakeNotification[] = [];
  let viewCount = 0;
  const notifier = new LoopCompletedNotifier({
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onViewLoop: () => {
      viewCount += 1;
    },
  });

  notifier.notifyCompleted(makeNotice("loop-1"));
  notifications[0].action(0);
  notifications[0].click();

  assert.equal(viewCount, 1);
});

test("LoopCompletedNotifier ignores notices with a blank loop id", () => {
  const notifications: FakeNotification[] = [];
  const notifier = new LoopCompletedNotifier({
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onViewLoop: () => {},
  });

  notifier.notifyCompleted(makeNotice("   "));

  assert.equal(notifications.length, 0);
});

test("LoopCompletedNotifier logs when the view action throws", () => {
  const notifications: FakeNotification[] = [];
  const logs: string[] = [];
  const notifier = new LoopCompletedNotifier({
    createNotification: (options) => {
      const notification = new FakeNotification(options);
      notifications.push(notification);
      return notification;
    },
    supportsActions: () => true,
    onViewLoop: () => {
      throw new Error("window gone");
    },
    log: (message) => logs.push(message),
  });

  notifier.notifyCompleted(makeNotice("loop-1"));
  notifications[0].click();

  assert.ok(logs[0].includes("window gone"));
});

function makeNotice(
  loopId: string,
  overrides: Partial<LoopCompletedNotice> = {}
): LoopCompletedNotice {
  return { loopId, command: "EXECUTE", ...overrides };
}

class FakeNotification implements LoopCompletedNotification {
  readonly options: LoopCompletedNotificationOptions;
  shown = false;
  private clickListener: (() => void) | null = null;
  private actionListener: ((_event: unknown, index: number) => void) | null =
    null;

  constructor(options: LoopCompletedNotificationOptions) {
    this.options = options;
  }

  on(event: "click" | "action", listener: unknown): void {
    if (event === "click") {
      this.clickListener = listener as () => void;
    } else {
      this.actionListener = listener as (
        _event: unknown,
        index: number
      ) => void;
    }
  }

  show(): void {
    this.shown = true;
  }

  click(): void {
    this.clickListener?.();
  }

  action(index: number): void {
    this.actionListener?.({}, index);
  }
}
