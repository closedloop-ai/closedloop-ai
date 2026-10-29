import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type SessionMeshPresenceInput,
  type SessionMeshWorkspace,
  sessionMeshInboxResponseValidator,
  sessionMeshPublishValidator,
  sessionMeshRosterResponseValidator,
} from "@repo/api/src/types/session-mesh";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import { outboxRePendFields } from "../sync/durable-outbox.js";
import {
  readBoundedResponseText,
  SessionRequestCredentialKind,
  sendSessionClApiRequest,
  unwrapApiEnvelope,
} from "../util/api-response-utils.js";
import { sessionMeshTraceSubjects } from "./session-mesh-artifact-trace.js";
import {
  executeMeshCommand,
  meshCommandValidator,
} from "./session-mesh-commands.js";
import { sessionMeshContextText } from "./session-mesh-context-text.js";
import {
  type Ledger,
  readLedger,
  type SessionMeshDenial,
} from "./session-mesh-delivery-ledger.js";
import {
  escalateSessionMeshDenial,
  isSessionMeshAssignmentClosed,
  isSessionMeshAssignmentOpen,
  isSessionMeshDenialBody,
  isSessionMeshProbeDue,
  rearmSessionMeshDenial,
  restoreSessionMeshDenial,
} from "./session-mesh-denial-policy.js";
import {
  recordSessionMeshEngagement,
  SessionMeshEngagement,
} from "./session-mesh-engagement.js";
import {
  recordSessionMeshEvidence,
  SessionMeshEvidenceObserver,
  sessionMeshEvidenceSeeds,
} from "./session-mesh-evidence-observer.js";
import type {
  SessionMeshHookEvent,
  SessionMeshHookResult,
} from "./session-mesh-hook-contract.js";
import {
  messageKind,
  nativeAgentId,
  nativeFiles,
  sessionIdFrom,
} from "./session-mesh-hook-event-fields.js";
import { matchesSessionMeshToken } from "./session-mesh-local-auth.js";
import {
  assertSessionMeshResponse,
  isItemScopedSessionMeshRejection,
  parseSessionMeshForbiddenCode,
  SessionMeshCloudError,
} from "./session-mesh-outbox-policy.js";
import { SessionMeshOverhead } from "./session-mesh-overhead.js";
import {
  SessionMeshRetainedPresence,
  sessionMeshEventLineage,
  sessionMeshPresenceFor,
} from "./session-mesh-presence-state.js";
import { sessionMeshEventPublications } from "./session-mesh-publications.js";
import { confirmSessionMeshReceipt } from "./session-mesh-receipt-confirmation.js";
import {
  mintSessionMeshReceipt,
  pruneDeliveredLocally,
} from "./session-mesh-receipts.js";
import { SessionMeshRuntimeMarker } from "./session-mesh-runtime-marker.js";
import type { ResolvedSessionMeshWorkspace } from "./session-mesh-workspace.js";

export type SessionMeshRuntimeOptions = {
  directory: string;
  localToken: string;
  getIdentity: () => {
    userId: string;
    organizationId: string;
    computeTargetId: string;
  } | null;
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string;
  invalidateAccessToken: (token: string) => void;
  resolveWorkspace: (
    cwd: string,
    file?: string,
    files?: string[]
  ) => Promise<ResolvedSessionMeshWorkspace>;
  fetch?: typeof fetch;
  log: (message: string) => void;
  now?: () => number;
  monotonicNow?: () => number;
};

/**
 * Main-process native hook runtime. Its atomic disk ledger survives process
 * restart and scopes every operation/receipt to org, user and compute target.
 * Cloud inbox remains authoritative: losing the ledger only re-delivers.
 * The ledger uses shared outbox status/retry mechanics; no daemon is created.
 */
export class SessionMeshRuntime {
  private readonly options: SessionMeshRuntimeOptions;
  private readonly file: string;
  private readonly ledger: Ledger;
  private readonly marker: SessionMeshRuntimeMarker;
  private readonly overhead: SessionMeshOverhead;
  private readonly engagement: SessionMeshEngagement;
  private readonly evidence: SessionMeshEvidenceObserver;
  private sequence: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private tickQueued = false;
  private probedSource: string | null = null;
  private serverDenial: SessionMeshDenial | null = null;
  /**
   * The source the cloud most recently ANSWERED for, on a probe it allowed.
   *
   * The PostHog assignment is resolved once at sign-in and never refreshed, so
   * without this a rollout that opens mid-session could never reach a running
   * client: the probe would clear the denial, every ordinary path would still
   * read the stale closed snapshot, and the next tick would re-latch. A 200 is
   * the same authority the 403 is, and it is the newer one. A later 403 clears
   * this again through {@link cacheServerDenial}, so the cloud stays in charge
   * in both directions.
   */
  private cloudAllowedSource: string | null = null;
  private readonly readyContext = new Map<
    string,
    { result: SessionMeshHookResult; createdAt: number }
  >();
  private readonly pendingEvents = new Map<string, SessionMeshHookEvent>();
  private readonly contextWaiters = new Map<
    string,
    Set<(result: SessionMeshHookResult) => void>
  >();
  private readonly deliveredLocally = new Map<string, number>();
  private readonly lastRosterContext = new Map<string, string>();
  private readonly sessions = new Map<
    string,
    { presence: SessionMeshPresenceInput; sourceKey: string; touched: number }
  >();
  private readonly retained = new SessionMeshRetainedPresence();

  constructor(options: SessionMeshRuntimeOptions) {
    this.options = options;
    this.file = path.join(options.directory, "delivery-ledger.json");
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.ledger = readLedger(this.file, options.log);
    this.serverDenial = restoreSessionMeshDenial(
      this.ledger.denial,
      this.now()
    );
    this.marker = new SessionMeshRuntimeMarker(options.directory, options.log);
    this.overhead = new SessionMeshOverhead({
      now: () => this.now(),
      monotonicNow: options.monotonicNow ?? (() => performance.now()),
      log: options.log,
    });
    this.engagement = new SessionMeshEngagement({ now: () => this.now() });
    this.evidence = new SessionMeshEvidenceObserver({ now: () => this.now() });
  }

  start(): void {
    this.stopped = false;
    const sourceKey = this.sourceKey();
    this.marker.refresh(this.isMeshDisabled(sourceKey) ? null : sourceKey);
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.tickQueued) {
        return;
      }
      this.tickQueued = true;
      this.serial(() => this.tick())
        .catch((error) => this.options.log(String(error)))
        .finally(() => {
          this.tickQueued = false;
        });
    }, 5000);
    this.timer.unref();
    this.serial(() => this.tick()).catch((error) =>
      this.options.log(String(error))
    );
  }

  stop(): void {
    this.stopped = true;
    this.marker.refresh(null);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sessions.clear();
    this.readyContext.clear();
    this.pendingEvents.clear();
    this.engagement.clear();
    this.evidence.clear();
    for (const waiters of this.contextWaiters.values()) {
      for (const finish of waiters) {
        finish({});
      }
    }
    this.contextWaiters.clear();
  }

  handle(event: SessionMeshHookEvent): Promise<SessionMeshHookResult> {
    if (!matchesSessionMeshToken(this.options.localToken, event.localToken)) {
      return Promise.reject(new Error("Unauthorized Session Mesh hook"));
    }
    const sourceKey = this.stopped ? null : this.sourceKey();
    if (event.hookType === "MeshCommand") {
      return this.runCommand(sourceKey, event);
    }
    if (!sourceKey) {
      return Promise.resolve({ awaitContext: false });
    }
    if (this.isMeshDisabled(sourceKey)) {
      return Promise.resolve({ awaitContext: false });
    }
    if (event.hookType === "AwaitContext") {
      return this.awaitContext(sourceKey, event);
    }
    if (event.hookType === "ContextDelivered") {
      this.serial(async () => {
        this.recordReceipt(sourceKey, event);
        await this.drain(sourceKey);
      }).catch((error) => this.options.log(String(error)));
      return Promise.resolve({});
    }
    const sessionId = sessionIdFrom(event);
    if (!sessionId) {
      return Promise.resolve({});
    }
    const key = `${sourceKey}:${nativeAgentId(event)}`;
    const eventKey = `${key}:${event.hookType}:${String(event.data.tool_use_id ?? nativeFiles(event).join("|"))}`;
    if (this.pendingEvents.size >= 500 && !this.pendingEvents.has(eventKey)) {
      this.options.log("Session Mesh event queue capacity reached");
      return Promise.resolve({});
    }
    const pending = this.pendingEvents.has(eventKey);
    this.pendingEvents.set(eventKey, event);
    if (!pending) {
      this.serial(async () => {
        const next = this.pendingEvents.get(eventKey);
        this.pendingEvents.delete(eventKey);
        if (
          !next ||
          this.stopped ||
          sourceKey !== this.sourceKey() ||
          this.isMeshDisabled(sourceKey)
        ) {
          return;
        }
        const context = await this.overhead.measure(
          sourceKey,
          nativeAgentId(next),
          () => this.handleSerial(next)
        );
        this.flushOverhead(sourceKey);
        if (!this.stopped && sourceKey === this.sourceKey()) {
          this.publishContext(
            key,
            context.additionalContext
              ? context
              : (this.readyContext.get(key)?.result ?? { awaitContext: false })
          );
        }
      }).catch((error) => {
        this.options.log(String(error));
        if (!this.stopped && sourceKey === this.sourceKey()) {
          this.publishContext(key, { awaitContext: false });
        }
      });
    }
    // No git, token refresh or cloud request is awaited on a model turn.
    if (["Stop", "SessionEnd", "SubagentStop"].includes(event.hookType)) {
      return Promise.resolve({});
    }
    const cached = this.readyContext.get(key);
    if (cached && this.now() - cached.createdAt >= 60_000) {
      this.lastRosterContext.delete(key);
    }
    const ready =
      cached && this.now() - cached.createdAt < 60_000 ? cached.result : {};
    this.readyContext.delete(key);
    return Promise.resolve(ready);
  }

  whenIdle(): Promise<unknown> {
    return this.sequence;
  }

  private publishContext(key: string, result: SessionMeshHookResult): void {
    const waiting = this.contextWaiters.get(key);
    if (waiting?.size) {
      this.contextWaiters.delete(key);
      let first = true;
      for (const finish of waiting) {
        finish(first ? result : {});
        first = false;
      }
      return;
    }
    if (this.readyContext.size >= 500 && !this.readyContext.has(key)) {
      this.readyContext.delete(this.readyContext.keys().next().value ?? "");
    }
    this.readyContext.set(key, { result, createdAt: this.now() });
  }

  /** Only the verified native-async adapter calls this separate long-poll path.
   * Ordinary lifecycle handling and all model-turn hooks remain nonblocking. */
  private awaitContext(
    sourceKey: string,
    event: SessionMeshHookEvent
  ): Promise<SessionMeshHookResult> {
    if (!sessionIdFrom(event)) {
      return Promise.resolve({});
    }
    const key = `${sourceKey}:${nativeAgentId(event)}`;
    const cached = this.readyContext.get(key);
    if (cached && this.now() - cached.createdAt < 60_000) {
      this.readyContext.delete(key);
      return Promise.resolve(cached.result);
    }
    const waiting =
      this.contextWaiters.get(key) ??
      new Set<(result: SessionMeshHookResult) => void>();
    if (
      waiting.size >= 2 ||
      (this.contextWaiters.size >= 500 && !this.contextWaiters.has(key))
    ) {
      return Promise.resolve({});
    }
    return new Promise((resolve) => {
      const finish = (result: SessionMeshHookResult) => {
        clearTimeout(timer);
        waiting.delete(finish);
        if (!waiting.size) {
          this.contextWaiters.delete(key);
        }
        resolve(!this.stopped && this.sourceKey() === sourceKey ? result : {});
      };
      const timer = setTimeout(() => finish({}), 5000);
      timer.unref();
      waiting.add(finish);
      this.contextWaiters.set(key, waiting);
    });
  }

  private async runCommand(
    sourceKey: string | null,
    event: SessionMeshHookEvent
  ): Promise<SessionMeshHookResult> {
    if (this.isMeshDisabled(sourceKey)) {
      throw new Error("Session Mesh disabled by server assignment");
    }
    const command = meshCommandValidator.parse(event.data);
    const session = this.sessions.get(command.agentId);
    if (
      !sourceKey ||
      session?.sourceKey !== sourceKey ||
      session.presence.harness !== event.harness
    ) {
      throw new Error(
        "Mesh commands require this harness's locally registered session in the current account"
      );
    }
    const commandResult = await executeMeshCommand(
      command,
      session.presence,
      (endpoint, body) =>
        endpoint === "/session-mesh/messages"
          ? this.publishCommand(sourceKey, body)
          : this.request(sourceKey, endpoint, body)
    );
    return { commandResult };
  }

  private publishCommand(sourceKey: string, body: unknown): Promise<unknown> {
    const publication = sessionMeshPublishValidator.parse(body);
    return this.serial(async () => {
      if (
        !this.enqueue(
          sourceKey,
          "/session-mesh/messages",
          publication,
          publication.idempotencyKey
        )
      ) {
        // A denial landed between `runCommand`'s gate and this serialized
        // callback. Absence from the ledger below would otherwise read as
        // `accepted: true` and report a message nothing sent or retained.
        throw new Error("Session Mesh disabled by server assignment");
      }
      const abandoned = await this.drain(sourceKey);
      const queued = this.ledger.operations.some(
        (item) =>
          item.id === publication.idempotencyKey && item.sourceKey === sourceKey
      );
      return {
        queued,
        accepted: !(queued || abandoned.has(publication.idempotencyKey)),
        idempotencyKey: publication.idempotencyKey,
      };
    });
  }

  private recordReceipt(sourceKey: string, event: SessionMeshHookEvent): void {
    const claimed = confirmSessionMeshReceipt({
      ledger: this.ledger,
      sourceKey,
      receiptKey: event.data.receipt,
      engagement: this.engagement,
      evidence: this.evidence,
      deliveredLocally: this.deliveredLocally,
      readyContext: this.readyContext,
      now: () => this.now(),
      enqueue: (path, body, id) => this.enqueue(sourceKey, path, body, id),
    });
    if (claimed) {
      this.persist();
    }
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.sequence.then(run, run);
    this.sequence = next.catch(() => undefined);
    return next;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Whether Mesh is OFF for this source, from either authority: a denial the
   * cloud confirmed, or this account's own evaluated PostHog assignment. Every
   * hook, drain, enqueue and request path reads this one predicate.
   */
  private isMeshDisabled(sourceKey: string | null): boolean {
    if (sourceKey === null) {
      return false;
    }
    if (this.serverDenial?.sourceKey === sourceKey) {
      return true;
    }
    if (this.cloudAllowedSource === sourceKey) {
      // The cloud allowed this source more recently than the sign-in snapshot
      // was taken, so the snapshot is the stale half of the disagreement.
      return false;
    }
    return isSessionMeshAssignmentClosed();
  }

  /** Persist the denial with the ledger so a restart resumes the escalation. */
  private recordDenial(next: SessionMeshDenial | null): void {
    this.serverDenial = next;
    this.ledger.denial = next ?? undefined;
    this.persist();
  }

  /**
   * Drop this source's queued operations once BOTH authorities agree Mesh is off.
   * Presence expires in 90 s and a claim describes an edit that has since
   * happened, so keeping them past that only walks the ledger toward its
   * 2,000-item hard error for an install that cannot deliver.
   *
   * THE CALLER GATES THIS ON THE LOCAL VERDICT, not on the 403 count alone. A
   * bare 403 cannot tell "not in the rollout" from "the gate could not read
   * PostHog" — `isFeatureFlagEnabledForAnyIdentity` folds an unavailable flag
   * service into the same denial — so a flag-service outage lasting a couple of
   * minutes would otherwise delete claims `publishCommand` already reported back
   * as `queued: true`. That is the same bar `latchAssignmentDenial` keeps: a
   * claim or an inbox disposition is a one-shot event whose drop is permanent.
   */
  private discardDeniedOperations(sourceKey: string): void {
    const remaining = this.ledger.operations.filter(
      (row) => row.sourceKey !== sourceKey
    );
    const dropped = this.ledger.operations.length - remaining.length;
    if (!dropped) {
      return;
    }
    this.ledger.operations = remaining;
    this.persist();
    this.options.log(
      `Session Mesh dropped ${dropped} queued operation(s) for a source the cloud reports disabled`
    );
  }

  private cacheServerDenial(sourceKey: string): void {
    const escalated = escalateSessionMeshDenial(this.serverDenial, sourceKey, {
      now: this.now(),
    });
    if (escalated.step > 0 && isSessionMeshAssignmentClosed()) {
      this.discardDeniedOperations(sourceKey);
    }
    if (isSessionMeshAssignmentOpen()) {
      // The two verdicts disagree: this account's own flag assignment reports
      // Mesh enabled and the cloud gate refuses it. Named rather than absorbed —
      // a silent disagreement is how the storm this closes stayed invisible.
      this.options.log(
        "Session Mesh cloud denied a source its own flag assignment reports enabled"
      );
    }
    this.cloudAllowedSource = null;
    this.recordDenial(escalated);
    this.marker.refresh(null);
    this.readyContext.clear();
    this.lastRosterContext.clear();
    for (const waiters of this.contextWaiters.values()) {
      for (const finish of waiters) {
        finish({ awaitContext: false });
      }
    }
    this.contextWaiters.clear();
  }

  private flushOverhead(sourceKey: string): void {
    this.overhead.flushSafely(sourceKey, (body) =>
      this.enqueue(
        sourceKey,
        "/session-mesh/feedback",
        body,
        body.idempotencyKey
      )
    );
  }

  private sourceKey(): string | null {
    const identity = this.options.getIdentity();
    return identity
      ? JSON.stringify([
          identity.organizationId,
          identity.userId,
          identity.computeTargetId,
        ])
      : null;
  }

  private persist(): void {
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.ledger), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  /** Whether the operation is now durably represented in the ledger. */
  private enqueue(
    sourceKey: string,
    endpoint: string,
    body: unknown,
    id: string = randomUUID(),
    method: "POST" | "DELETE" = "POST"
  ): boolean {
    if (this.isMeshDisabled(sourceKey)) {
      // Announced, not dropped quietly: every other caller is gated ahead of
      // this, so reaching it means a denial landed mid-turn.
      this.options.log(
        `Session Mesh declined to queue ${endpoint} for a disabled source`
      );
      return false;
    }
    if (
      this.ledger.operations.some(
        (item) => item.id === id && item.sourceKey === sourceKey
      )
    ) {
      // A previous atomic write may have failed after the in-memory enqueue.
      // Re-persist before claiming this retry is durably represented.
      this.persist();
      return true;
    }
    if (this.ledger.operations.length >= 2000) {
      throw new Error(
        "Session Mesh delivery queue is full; pending work retained"
      );
    }
    this.ledger.operations.push({
      id,
      sourceKey,
      path: endpoint,
      method,
      body,
      ...outboxRePendFields(new Date(this.now()).toISOString()),
    });
    this.persist();
    return true;
  }

  private async request(
    sourceKey: string,
    endpoint: string,
    body?: unknown,
    method: "POST" | "DELETE" = "POST",
    probe = false
  ): Promise<unknown> {
    if (!probe && this.isMeshDisabled(sourceKey)) {
      throw new Error("Session Mesh disabled by server assignment");
    }
    const token = await this.options.getAccessToken();
    if (!token || sourceKey !== this.sourceKey()) {
      throw new Error("Session Mesh identity unavailable");
    }
    const response = await sendSessionClApiRequest({
      apiOrigin: this.options.getApiOrigin(),
      path: endpoint,
      method: body === undefined ? "GET" : method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { "Content-Type": "application/json" },
      timeoutMs: 1500,
      credential: {
        credentialKind: SessionRequestCredentialKind.AccessToken,
        token,
      },
      onUnauthorized: this.options.invalidateAccessToken,
      fetch: this.options.fetch,
    });
    if (!response.ok) {
      // The 403 body is read exactly ONCE here: it both latches a rollout denial
      // and tells the drain whether this refusal was about one operation, and a
      // `Response` body cannot be consumed twice.
      const code =
        response.status === 403 && sourceKey === this.sourceKey()
          ? await this.readForbiddenCode(sourceKey, response)
          : null;
      throw new SessionMeshCloudError(response.status, code);
    }
    const text = await readBoundedResponseText(response, 512 * 1024);
    if (text.truncated) {
      throw new Error("Session Mesh response too large");
    }
    const result: unknown = JSON.parse(text.text);
    if (sourceKey !== this.sourceKey()) {
      throw new Error("Session Mesh identity changed");
    }
    return unwrapApiEnvelope(result);
  }

  /**
   * Latch a rollout denial if that is what this 403 is, and return the body's
   * API error code for the drain to read. `null` for a body with no parseable
   * code — a proxy's HTML 403 — which the drain treats as source-wide.
   */
  private async readForbiddenCode(
    sourceKey: string,
    response: Response
  ): Promise<string | null> {
    const denied = await readBoundedResponseText(response, 8192);
    if (denied.truncated || sourceKey !== this.sourceKey()) {
      return null;
    }
    if (isSessionMeshDenialBody(denied.text)) {
      this.cacheServerDenial(sourceKey);
    }
    return parseSessionMeshForbiddenCode(denied.text);
  }

  /** Returns the ids of operations abandoned after their one attempt. */
  private async drain(sourceKey: string): Promise<Set<string>> {
    const abandoned = new Set<string>();
    // Rows a pre-fire-and-forget build left waiting out a backoff are skipped
    // until due, and selected before the batch cap so they cannot starve it.
    for (const item of this.ledger.operations
      .filter(
        (row) =>
          row.sourceKey === sourceKey &&
          row.status === OutboxStatus.Pending &&
          !(row.nextAttemptAt && Date.parse(row.nextAttemptAt) > this.now())
      )
      .slice(0, 20)) {
      try {
        const response = await this.request(
          sourceKey,
          item.path,
          item.body,
          item.method
        );
        assertSessionMeshResponse(item.path, item.method, response);
        this.ledger.operations = this.ledger.operations.filter(
          (row) => row !== item
        );
        this.persist();
      } catch (error) {
        // Fire-and-forget: sessions live less than a day, so an operation
        // retried later is stale by the time it lands (operator ruling,
        // 2026-10-06).
        abandoned.add(item.id);
        this.discardOperation(
          item,
          `Session Mesh abandoned an operation after its one attempt: ${String(error)}`
        );
        // A 403 carrying the server's disable verdict was just cached as a
        // denial, which refuses every row behind it the same way.
        if (
          this.isMeshDisabled(sourceKey) ||
          !isItemScopedSessionMeshRejection(error)
        ) {
          break;
        }
      }
    }
    return abandoned;
  }

  private discardOperation(item: object, logMessage: string): void {
    this.ledger.operations = this.ledger.operations.filter(
      (row) => row !== item
    );
    this.persist();
    this.options.log(logMessage);
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const sourceKey = this.sourceKey();
    this.marker.refresh(this.isMeshDisabled(sourceKey) ? null : sourceKey);
    if (!sourceKey) {
      this.sessions.clear();
      return;
    }
    if (
      (this.probedSource !== sourceKey || this.isMeshDisabled(sourceKey)) &&
      !(await this.probeEnabled(sourceKey))
    ) {
      return;
    }
    for (const [id, session] of this.sessions) {
      if (
        session.sourceKey !== sourceKey ||
        this.now() - session.touched > 300_000
      ) {
        this.sessions.delete(id);
        continue;
      }
      const context = await this.overhead.measure(sourceKey, id, async () => {
        await this.request(
          sourceKey,
          "/session-mesh/presence",
          session.presence
        );
        return this.pollContext(sourceKey, id, session.presence.workspace);
      });
      if (
        !this.stopped &&
        sourceKey === this.sourceKey() &&
        context.additionalContext
      ) {
        this.publishContext(`${sourceKey}:${id}`, context);
      }
    }
    this.flushOverhead(sourceKey);
    await this.drain(sourceKey);
  }

  /**
   * Confirm with the cloud that Mesh is enabled for `sourceKey`, and report
   * whether the rest of the tick may run.
   *
   * Returns `false` — no probe sent — while a denial's escalating wait stands. A
   * closed local verdict arms that wait without a request, which is ISS-11425's
   * suppression: a disabled install used to reach the `await` below once a minute
   * forever. The wait still lapses, so the cloud stays the authority.
   */
  private async probeEnabled(sourceKey: string): Promise<boolean> {
    if (isSessionMeshAssignmentClosed()) {
      this.latchAssignmentDenial(sourceKey);
    }
    if (!isSessionMeshProbeDue(this.serverDenial, sourceKey, this.now())) {
      return false;
    }
    this.probedSource = sourceKey;
    if (this.serverDenial?.sourceKey === sourceKey) {
      // Re-armed BEFORE the request, so a probe that hangs or fails leaves the
      // next attempt a whole step away instead of the next 5 s tick.
      this.recordDenial(
        rearmSessionMeshDenial(this.serverDenial, { now: this.now() })
      );
    }
    sessionMeshRosterResponseValidator.parse(
      await this.request(
        sourceKey,
        "/session-mesh/presence",
        undefined,
        "POST",
        true
      )
    );
    // Cleared before the guard below: a concurrent stop must not persist a
    // denial the cloud just answered away into the next runtime built here.
    this.cloudAllowedSource = sourceKey;
    this.recordDenial(null);
    if (sourceKey !== this.sourceKey() || this.stopped) {
      return false;
    }
    this.marker.refresh(sourceKey);
    return true;
  }

  /**
   * Fold an evaluated CLOSED assignment into the denial the cloud's 403 would
   * have produced, with no request sent. Idempotent: the verdict is re-read on
   * every tick, and escalating a wait on each read would be racing this
   * process's own clock rather than the cloud.
   *
   * IT DISCARDS NOTHING, unlike a confirmed 403's: this verdict is resolved at
   * sign-in and can be stale against a flag that flipped since, and a claim or an
   * inbox disposition is a one-shot event whose drop is permanent.
   */
  private latchAssignmentDenial(sourceKey: string): void {
    if (
      this.serverDenial?.sourceKey === sourceKey ||
      this.cloudAllowedSource === sourceKey
    ) {
      return;
    }
    this.recordDenial(
      escalateSessionMeshDenial(null, sourceKey, { now: this.now() })
    );
  }

  private async handleSerial(
    event: SessionMeshHookEvent
  ): Promise<SessionMeshHookResult> {
    const sourceKey = this.sourceKey();
    if (!sourceKey) {
      return {};
    }
    const sessionId = sessionIdFrom(event);
    const cwd = typeof event.data.cwd === "string" ? event.data.cwd : "";
    if (!(sessionId && cwd)) {
      return {};
    }
    const agentId = nativeAgentId(event);
    const files = nativeFiles(event);
    const file = files[0];
    const { branch, root, ...workspace } = await this.options.resolveWorkspace(
      cwd,
      file,
      files
    );
    if (this.stopped || sourceKey !== this.sourceKey()) {
      return {};
    }
    const trace = sessionMeshTraceSubjects(event, workspace.repository);
    const presence = sessionMeshPresenceFor({
      prior: this.retained.get(agentId),
      sourceKey,
      agentId,
      sessionId,
      harness: event.harness,
      expiresInSeconds: event.hookType === "Stop" ? 15 : 90,
      workspace,
      trace,
      ...(branch ? { branch } : {}),
    });
    if (this.sessions.size >= 500 && !this.sessions.has(agentId)) {
      throw new Error("Session Mesh live roster capacity reached");
    }
    this.sessions.set(agentId, { presence, sourceKey, touched: this.now() });
    this.retained.remember(agentId, { presence, sourceKey });
    this.enqueue(
      sourceKey,
      "/session-mesh/presence",
      presence,
      `presence:${agentId}`
    );
    const observed = {
      sourceKey,
      agentId,
      toolName: event.data.tool_name,
      toolInput: event.data.tool_input,
      files,
      // The git TOPLEVEL, for the reason the publish below states.
      workspaceRoot: root ?? cwd,
    };
    recordSessionMeshEngagement(this.engagement, observed, (path, body, id) =>
      this.enqueue(sourceKey, path, body, id)
    );
    // The same stream, read for per-delivery usefulness evidence. Operator
    // ruling 2026-10-01: "yes wire it into the hook pipeline; we need it for the
    // round trip." (ISS-11755, #8289 warning decision 2.)
    recordSessionMeshEvidence(this.evidence, observed);
    const kind = messageKind(event, file);
    for (const published of sessionMeshEventPublications({
      agentId,
      event,
      file,
      kind,
      trace,
      // This event's symbols and subjects, with the retained paths the
      // publishers carried before retention moved out of this method.
      workspace,
      retainedPaths: presence.workspace.paths,
      lineage: sessionMeshEventLineage(presence, trace),
      // The git TOPLEVEL, not the cwd. A session started in `apps/desktop`
      // would otherwise relativize `/repo/apps/api/x.ts` against that
      // subdirectory — dropping it for failing the prefix test, or, when the
      // path is under the subdirectory, publishing `src/x.ts` where every peer
      // carries `apps/desktop/src/x.ts`. The server's path overlap is exact, so
      // either spelling routes to nobody.
      workspaceRoot: root ?? cwd,
    })) {
      if (published) {
        this.enqueue(
          sourceKey,
          "/session-mesh/messages",
          published.publication,
          published.idempotencyKey
        );
      }
    }
    if (kind === "session_ended") {
      this.retained.forget(agentId);
      this.enqueue(
        sourceKey,
        "/session-mesh/presence",
        { agentId },
        `unregister:${agentId}`,
        "DELETE"
      );
    }
    await this.drain(sourceKey);
    if (["session_ended", "Stop"].includes(kind ?? event.hookType)) {
      this.sessions.delete(agentId);
      return {};
    }
    if (
      ![
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "SubagentStart",
      ].includes(event.hookType)
    ) {
      return {};
    }
    return this.pollContext(sourceKey, agentId, presence.workspace);
  }

  private async pollContext(
    sourceKey: string,
    agentId: string,
    workspace: SessionMeshWorkspace
  ): Promise<SessionMeshHookResult> {
    const inbox = await this.request(
      sourceKey,
      `/session-mesh/inbox?agentId=${encodeURIComponent(agentId)}`
    );
    const roster = await this.request(
      sourceKey,
      `/session-mesh/presence?repository=${encodeURIComponent(workspace.repository)}`
    );
    const deliveries = sessionMeshInboxResponseValidator.parse(inbox).messages;
    const { agents, nextCursor } =
      sessionMeshRosterResponseValidator.parse(roster);
    const peers = agents.filter((agent) => agent.agentId !== agentId);
    pruneDeliveredLocally(this.deliveredLocally, this.now());
    const selectedDeliveries = deliveries
      .filter(
        (delivery) =>
          !this.deliveredLocally.has(
            `${sourceKey}:${agentId}:${delivery.message.id}`
          )
      )
      .slice(0, 4);
    const selected = selectedDeliveries.map((delivery) => delivery.message);
    const prompts = this.engagement.pendingPrompts(sourceKey, agentId);
    const context = sessionMeshContextText({
      agentId,
      peers,
      selected,
      workspace,
      nextCursor,
      dispositionPrompts: prompts,
    });
    if (!selected.length) {
      const key = `${sourceKey}:${agentId}`;
      if (this.lastRosterContext.get(key) === context) {
        return {};
      }
      // No receipt on this path, so there is nothing to confirm against; the
      // handler prints it directly.
      this.engagement.markPrompted(sourceKey, agentId, prompts);
      if (this.lastRosterContext.size >= 500) {
        this.lastRosterContext.delete(
          this.lastRosterContext.keys().next().value ?? ""
        );
      }
      this.lastRosterContext.set(key, context);
      return { additionalContext: context };
    }
    const receiptId = mintSessionMeshReceipt(this.ledger, {
      sourceKey,
      agentId,
      selected,
      now: this.now(),
      promptedMessageIds: prompts.map((item) => item.messageId),
      evidence: sessionMeshEvidenceSeeds(selectedDeliveries, workspace.paths),
    });
    this.persist();
    return { additionalContext: context, receipt: receiptId };
  }
}
