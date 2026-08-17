/**
 * Typed ClosedLoop REST client. Replaces the `cl_curl` one-liners scattered
 * across the bash. Envelope is `{ success, data }`; every call throws on
 * `success:false` or a non-2xx status.
 */

/** Trailing-slash matcher for normalizing the configured base URL. */
const TRAILING_SLASH = /\/$/;

/** ClosedLoop document/feature statuses used by the crew workflow. */
export const CLStatus = {
  Triage: "TRIAGE",
  Todo: "TODO",
  InProgress: "IN_PROGRESS",
  InReview: "IN_REVIEW",
  Blocked: "BLOCKED",
  Canceled: "CANCELED",
  Done: "DONE",
} as const;
export type CLStatus = (typeof CLStatus)[keyof typeof CLStatus];

export type CLTag = {
  id: string;
  name: string;
  color?: string;
};

export type CLDocument = {
  id: string;
  slug: string;
  type: string;
  title: string;
  content?: string;
  status: string;
  priority?: string;
  assigneeId?: string | null;
  tags?: Array<{ id: string; name: string }>;
};

export type ClosedLoopConfig = {
  apiKey: string;
  projectSlug: string;
  baseUrl?: string;
};

type Envelope<T> = {
  success: boolean;
  data: T;
  error?: unknown;
};

export class ClosedLoopClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly projectSlug: string;

  constructor(cfg: ClosedLoopConfig) {
    this.apiKey = cfg.apiKey;
    this.projectSlug = cfg.projectSlug;
    this.baseUrl = (cfg.baseUrl ?? "https://api.closedloop.ai").replace(
      TRAILING_SLASH,
      ""
    );
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    // Most endpoints must return a `data` payload; a couple (comment/tag POSTs)
    // legitimately return an empty envelope. Default to requiring `data` so a
    // missing payload throws a clear error at the boundary instead of silently
    // handing `undefined` to a caller typed `T` (which then crashes later on,
    // e.g. `created.id`, with a confusing message).
    opts: { requireData?: boolean } = {}
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: Envelope<T> | undefined;
    try {
      parsed = text ? (JSON.parse(text) as Envelope<T>) : undefined;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || (parsed && parsed.success === false)) {
      const detail = parsed?.error ?? text.slice(0, 300);
      throw new Error(
        `ClosedLoop ${method} ${path} → ${res.status}: ${JSON.stringify(detail)}`
      );
    }
    const requireData = opts.requireData ?? true;
    if (requireData && (parsed === undefined || parsed.data === undefined)) {
      throw new Error(
        `ClosedLoop ${method} ${path} → ${res.status}: missing "data" in response envelope`
      );
    }
    return parsed?.data as T;
  }

  /**
   * List documents of a type in this project.
   *
   * Since FEA-4373 the `/documents` endpoint honors `limit` (a page size),
   * whereas it previously ignored it and returned every matching row. Callers
   * here — notably the open-finding dedup set in `fileFindings` — need the
   * COMPLETE set, not a first page, or older open findings get filed again. So
   * this follows the pages internally via `offset` until a short (partial) page
   * comes back, and returns the concatenated result. A `limit` here is the page
   * size, not a hard cap; `maxPages` bounds the walk against a pathological
   * corpus so the client can never spin unbounded.
   */
  async listDocuments(opts: {
    type: string;
    limit?: number;
    assigneeId?: string;
    maxPages?: number;
  }): Promise<CLDocument[]> {
    const pageSize = opts.limit ?? 100;
    const maxPages = opts.maxPages ?? DEFAULT_LIST_DOCUMENTS_MAX_PAGES;
    const all: CLDocument[] = [];
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({
        projectId: this.projectSlug,
        type: opts.type,
        limit: String(pageSize),
        offset: String(page * pageSize),
      });
      if (opts.assigneeId) {
        q.set("assigneeId", opts.assigneeId);
      }
      const batch = await this.req<CLDocument[]>(
        "GET",
        `/documents?${q.toString()}`
      );
      all.push(...batch);
      // A short page means the server has no more rows — stop before issuing an
      // empty extra request.
      if (batch.length < pageSize) {
        break;
      }
    }
    return all;
  }

  createDocument(input: {
    type: string;
    title: string;
    content: string;
    status: CLStatus | string;
    priority?: string;
    assigneeId?: string;
    sourceId?: string;
  }): Promise<CLDocument> {
    return this.req<CLDocument>("POST", "/documents", {
      projectId: this.projectSlug,
      ...input,
    });
  }

  setStatus(slug: string, status: CLStatus | string): Promise<CLDocument> {
    return this.req<CLDocument>("PUT", `/documents/${slug}`, { status });
  }

  /** Post a plain comment onto a document. */
  addComment(slug: string, body: string): Promise<unknown> {
    return this.req<unknown>(
      "POST",
      `/documents/${slug}/comments`,
      { content: body },
      { requireData: false }
    );
  }

  // ── tags ──

  listTags(): Promise<CLTag[]> {
    return this.req<CLTag[]>("GET", `/tags?projectId=${this.projectSlug}`);
  }

  /** Find (or create) a tag by name; returns its id, or null if creation is unauthorized. */
  async ensureTag(name: string, color = "blue"): Promise<string | null> {
    const existing = (await this.listTags()).find((t) => t.name === name);
    if (existing) {
      return existing.id;
    }
    try {
      const created = await this.req<CLTag>("POST", "/tags", {
        projectId: this.projectSlug,
        name,
        color,
      });
      return created.id;
    } catch {
      // Non-admin keys cannot create tags; the bash tolerates this.
      return null;
    }
  }

  /** Attach a tag to a document entity. */
  attachTag(documentId: string, tagId: string): Promise<unknown> {
    return this.req<unknown>(
      "POST",
      "/entity-tags",
      { entityId: documentId, tagId },
      { requireData: false }
    );
  }
}

/**
 * Safety bound on {@link ClosedLoopClient.listDocuments}'s page walk. At the
 * default page size of 100 this covers 5,000 documents before stopping; well
 * past any real open-finding corpus, and it keeps the max `offset` under the
 * server's accepted ceiling so the walk can never spin unbounded.
 */
const DEFAULT_LIST_DOCUMENTS_MAX_PAGES = 50;
