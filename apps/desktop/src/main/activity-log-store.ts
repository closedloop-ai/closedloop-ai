import { randomUUID } from "node:crypto";
import Store from "electron-store";

export type ActivityEvent = {
  id: string;
  type?: "request" | "security";
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  detail?: string;
  requestSizeBytes?: number;
  responseSizeBytes?: number;
};

type ActivityStoreSchema = {
  events: ActivityEvent[];
};

type LegacyActivityEvent = ActivityEvent & {
  requestBody?: unknown;
  responseBody?: unknown;
};

const SAFE_ACTIVITY_EVENT_KEYS = new Set([
  "id",
  "type",
  "timestamp",
  "method",
  "path",
  "statusCode",
  "durationMs",
  "detail",
  "requestSizeBytes",
  "responseSizeBytes",
]);

export type ActivityLogStoreOptions = {
  maxEntries?: number;
  cwd?: string;
  name?: string;
};

export class ActivityLogStore {
  private readonly maxEntries: number;
  private readonly events: ActivityEvent[];
  private readonly store: Store<ActivityStoreSchema>;

  constructor(options?: ActivityLogStoreOptions | number) {
    const opts =
      typeof options === "number" ? { maxEntries: options } : options;
    this.maxEntries = opts?.maxEntries ?? 200;
    this.store = new Store<ActivityStoreSchema>({
      name: opts?.name ?? "desktop-activity-log",
      cwd: opts?.cwd,
      defaults: {
        events: [],
      },
    });
    const persistedEvents = this.store.get("events", []);
    const raw = Array.isArray(persistedEvents) ? persistedEvents : [];
    const selected = raw.slice(0, this.maxEntries) as LegacyActivityEvent[];
    this.events = selected.map((event) => sanitizeActivityEvent(event));
    let needsPersist = raw.length > this.maxEntries;
    for (const event of selected) {
      if (hasUnsafeActivityFields(event)) {
        needsPersist = true;
      }
    }
    if (needsPersist) {
      this.persist();
    }
  }

  add(
    event: Omit<ActivityEvent, "id"> & {
      requestBody?: unknown;
      responseBody?: unknown;
    }
  ): ActivityEvent {
    const withId = sanitizeActivityEvent({
      id: randomUUID(),
      ...event,
    });
    this.events.unshift(withId);
    if (this.events.length > this.maxEntries) {
      this.events.length = this.maxEntries;
    }
    this.persist();
    return withId;
  }

  list(): ActivityEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events.length = 0;
    this.persist();
  }

  private persist(): void {
    this.store.set("events", this.events);
  }
}

function sanitizeActivityEvent(event: LegacyActivityEvent): ActivityEvent {
  const safeEvent: ActivityEvent = {
    id: event.id,
    timestamp: event.timestamp,
    method: event.method,
    path: event.path,
    statusCode: event.statusCode,
    durationMs: event.durationMs,
  };
  if (event.type !== undefined) {
    safeEvent.type = event.type;
  }
  if (event.detail !== undefined) {
    safeEvent.detail = event.detail;
  }
  if (event.requestSizeBytes !== undefined) {
    safeEvent.requestSizeBytes = event.requestSizeBytes;
  }
  if (event.responseSizeBytes !== undefined) {
    safeEvent.responseSizeBytes = event.responseSizeBytes;
  }
  return safeEvent;
}

function hasUnsafeActivityFields(event: LegacyActivityEvent): boolean {
  return Object.keys(event).some((key) => !SAFE_ACTIVITY_EVENT_KEYS.has(key));
}
