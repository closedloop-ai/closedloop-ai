import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  asOtlpRecordArray,
  decodeOtlpAnyValue,
  decodeOtlpBytesToHex,
  numberFromOtlpValue,
  walkOtlpLogRecords,
  walkOtlpMetrics,
  walkOtlpTraceSpans,
} from "../otlp/decode-utilities.js";
import {
  identifiesClaude,
  identifiesCodex,
  otlpIdentityValues,
} from "../otlp/harness-identity.js";
import {
  getOtlpRequestType,
  getOtlpResponseType,
  OtlpExportKind,
  OtlpProtoDescriptorError,
} from "../otlp/proto-descriptor.js";
import { asRecord } from "../util/api-response-utils.js";
import {
  DEFAULT_OTLP_RECEIVER_HOST,
  DEFAULT_OTLP_RECEIVER_PORT,
  makeOtlpReceiverUnavailableState,
  type OtlpReceiverState,
  OtlpReceiverUnavailableReason,
  setOtlpReceiverStateForProcess,
} from "./otlp-receiver-state.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_BODY_TIMEOUT_MS = 30_000;
const CONTENT_TYPE_PROTOBUF = "application/x-protobuf";
const UNKNOWN_EXPORT_DIAGNOSTIC_LIMIT = 10;

/**
 * Headers only a browser sets. A CLI OTLP exporter sends none of them, so any
 * one being present means the caller is a web page — see
 * `disallowedCallerReason`.
 */
const BROWSER_ORIGIN_HEADERS = [
  "origin",
  "sec-fetch-site",
  "sec-fetch-mode",
] as const;

/**
 * How many ACKed exports may be awaiting their callback at once.
 *
 * The receiver ACKs before dispatching, so without a cap a burst would queue
 * unbounded work against the shared DB write queue. At the cap the OLDEST
 * pending export is dropped rather than the newest: a burst is most often a
 * backlog flush, and the newest data is the data a reader is about to look at.
 */
const MAX_PENDING_DISPATCHES = 64;

/**
 * How long `stop()` waits for queued callbacks before giving up and saying so.
 * Bounded because a wedged store must not be able to hold app shutdown open.
 */
const DISPATCH_DRAIN_TIMEOUT_MS = 5000;

// Resource container -> instrumentation-scope array, one entry per OTLP signal.
// discriminateHarness() never inspects scope names, so the diagnostic surfaces
// them to reveal where an unrecognized harness stamps its identity.
const SCOPE_CONTAINER_KEYS = [
  { resource: "resourceMetrics", scopes: "scopeMetrics" },
  { resource: "resourceLogs", scopes: "scopeLogs" },
  { resource: "resourceSpans", scopes: "scopeSpans" },
] as const;

export const OtlpHarness = {
  Claude: "claude",
  Codex: "codex",
  Unknown: "unknown",
} as const;

export type OtlpHarness = (typeof OtlpHarness)[keyof typeof OtlpHarness];

export type OtlpScalarValue = string | number | boolean;
export type OtlpResourceAttributes = Record<string, OtlpScalarValue>;

export type NormalizedOtlpExport = {
  kind: OtlpExportKind;
  harness: Exclude<OtlpHarness, typeof OtlpHarness.Unknown>;
  resourceAttributes: OtlpResourceAttributes[];
  metricNames: string[];
  logSummaries: OtlpLogSummary[];
  spanSummaries: OtlpSpanSummary[];
  decodedPayload: Record<string, unknown>;
};

export type UnknownOtlpExport = Omit<NormalizedOtlpExport, "harness"> & {
  harness: typeof OtlpHarness.Unknown;
};

export type OtlpLogSummary = {
  severityText?: string;
  severityNumber?: number;
  body?: OtlpScalarValue;
};

export type OtlpSpanSummary = {
  name: string;
  traceId?: string;
  spanId?: string;
};

export type OtlpHttpReceiverOptions = {
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  onClaudeExport?: (payload: NormalizedOtlpExport) => void | Promise<void>;
  onCodexExport?: (payload: NormalizedOtlpExport) => void | Promise<void>;
  onUnknownExport?: (payload: UnknownOtlpExport) => void | Promise<void>;
  onBindError?: (reason: string) => void;
  log?: (message: string) => void;
  /**
   * How many ACKed exports may await their callback before the OLDEST is
   * dropped. Defaults to {@link MAX_PENDING_DISPATCHES}; injectable so the
   * bound can be driven in a test without queueing 64 real exports.
   */
  maxPendingDispatches?: number;
  /**
   * ISS-10717: called when an ACKed export is evicted before its callback runs.
   *
   * The response has already gone out, so the exporter will never re-send it —
   * the export is simply gone, and before this hook the only record was a log
   * line. Without a count, a cloud consumer cannot tell a session that produced
   * no permission events from one whose export was evicted here, so every synced
   * count would read as authoritative when it is a lower bound.
   *
   * The payload's SIGNAL count is not knowable at this point (it is decoded
   * further downstream), so the callback is told the harness and nothing more:
   * one call is one lost EXPORT.
   */
  onExportDropped?: (harness: OtlpHarness) => void;
};

type DecodedOtlpExport = Omit<NormalizedOtlpExport, "harness">;

type OtlpDispatchPayload = NormalizedOtlpExport | UnknownOtlpExport;

type CallbackDispatch = {
  payload: OtlpDispatchPayload;
  callback?: (payload: OtlpDispatchPayload) => void | Promise<void>;
};

export class OtlpHttpReceiver {
  private readonly host: string;
  private readonly maxBodyBytes: number;
  private readonly options: OtlpHttpReceiverOptions;
  private readonly port: number;
  private boundPort: number | null = null;
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();
  private state: OtlpReceiverState;
  /** ACKed exports whose callback has not run yet. Bounded, FIFO, drained by `stop()`. */
  private readonly pendingDispatches: CallbackDispatch[] = [];
  private readonly maxPendingDispatches: number;
  private draining: Promise<void> | null = null;

  constructor(options: OtlpHttpReceiverOptions = {}) {
    this.options = options;
    this.host = options.host ?? DEFAULT_OTLP_RECEIVER_HOST;
    this.port = options.port ?? DEFAULT_OTLP_RECEIVER_PORT;
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
    this.maxPendingDispatches = Math.max(
      1,
      options.maxPendingDispatches ?? MAX_PENDING_DISPATCHES
    );
    this.state = makeOtlpReceiverUnavailableState(
      OtlpReceiverUnavailableReason.NotStarted,
      this.port
    );
  }

  getState(): OtlpReceiverState {
    return this.state;
  }

  getBoundAddress(): AddressInfo | null {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? address : null;
  }

  start(): Promise<OtlpReceiverState> {
    if (this.server) {
      return Promise.resolve(this.state);
    }
    if (this.host !== DEFAULT_OTLP_RECEIVER_HOST) {
      const state = makeOtlpReceiverUnavailableState(
        OtlpReceiverUnavailableReason.InvalidHost,
        this.port
      );
      this.setState(state);
      this.options.onBindError?.("OTLP receiver must bind 127.0.0.1 only.");
      return Promise.resolve(state);
    }

    return new Promise<OtlpReceiverState>((resolve) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.on("close", () => {
          this.sockets.delete(socket);
        });
      });
      server.on("error", (error: NodeJS.ErrnoException) => {
        const state = makeOtlpReceiverUnavailableState(
          OtlpReceiverUnavailableReason.BindFailed,
          this.port
        );
        this.server = null;
        this.setState(state);
        const reason =
          error.code === "EADDRINUSE"
            ? `OTLP receiver port ${this.port} is already in use.`
            : `OTLP receiver bind failed: ${error.message}`;
        this.log(reason);
        this.options.onBindError?.(reason);
        resolve(state);
      });
      server.listen(this.port, DEFAULT_OTLP_RECEIVER_HOST, () => {
        const address = server.address() as AddressInfo | null;
        this.boundPort = address?.port ?? this.port;
        const state: OtlpReceiverState = {
          available: true,
          host: DEFAULT_OTLP_RECEIVER_HOST,
          port: this.boundPort,
        };
        this.setState(state);
        this.log(
          `OTLP receiver ready on http://${DEFAULT_OTLP_RECEIVER_HOST}:${this.boundPort}`
        );
        resolve(state);
      });
      this.server = server;
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    this.setState(
      makeOtlpReceiverUnavailableState(
        OtlpReceiverUnavailableReason.Stopped,
        this.port
      )
    );
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          this.sockets.clear();
          resolve();
        });
        server.closeAllConnections();
        for (const socket of this.sockets) {
          socket.destroy();
        }
      });
    }
    // AFTER the socket is closed, so nothing new can be queued behind us. These
    // exports were already ACKed, so dropping them here would mean telling an
    // exporter we kept data we then threw away.
    await this.drainWithDeadline();
  }

  private setState(state: OtlpReceiverState): void {
    this.state = state;
    setOtlpReceiverStateForProcess(state);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Binding 127.0.0.1 keeps remote hosts off the socket; it does NOT stop a
    // page the user is browsing from reaching it. A DNS-rebinding attacker
    // resolves their own hostname to 127.0.0.1 and a browser then issues
    // same-origin requests to this port — the socket is loopback, the caller is
    // not. Since ISS-7352 this receiver WRITES to the local store, so the two
    // header checks below are what actually gates that write.
    const rejection = disallowedCallerReason(req);
    if (rejection) {
      this.log(`OTLP receiver refused a request: ${rejection}`);
      this.respondText(res, 403, "forbidden");
      return;
    }
    const kind = kindForPath(req.url ?? "");
    if (!kind) {
      this.respondText(res, 404, "not found");
      return;
    }
    if (req.method !== "POST") {
      this.respondText(res, 405, "method not allowed");
      return;
    }
    const contentType = getSupportedOtlpContentType(
      req.headers["content-type"]
    );
    if (!contentType) {
      this.respondText(res, 415, "unsupported media type");
      return;
    }

    readBody(req, this.maxBodyBytes, REQUEST_BODY_TIMEOUT_MS)
      .then((body) => {
        let decoded: DecodedOtlpExport;
        try {
          decoded = decodeOtlpExport(kind, body);
        } catch (error) {
          if (error instanceof OtlpProtoDescriptorError) {
            this.log("OTLP receiver descriptor initialization failed.");
            this.respondText(res, 500, "otlp receiver unavailable");
            return;
          }
          this.respondText(res, 400, "malformed otlp payload");
          return;
        }
        const dispatch = this.prepareDispatch(decoded);
        let responseBody: Buffer;
        try {
          responseBody = encodeEmptyOtlpResponse(kind);
        } catch (error) {
          if (error instanceof OtlpProtoDescriptorError) {
            this.log("OTLP receiver descriptor initialization failed.");
            this.respondText(res, 500, "otlp receiver unavailable");
            return;
          }
          throw error;
        }
        this.respondProtobuf(res, 200, responseBody);
        this.dispatchAfterAck(dispatch);
      })
      .catch((error: unknown) => {
        const status = statusForBodyReadError(error);
        this.respondText(res, status, bodyForBodyReadStatus(status), {
          closeConnection:
            error instanceof PayloadTooLargeError ||
            error instanceof RequestTimeoutError,
          onEnd:
            error instanceof PayloadTooLargeError ||
            error instanceof RequestTimeoutError
              ? () => req.destroy()
              : undefined,
        });
      });
  }

  private prepareDispatch(decoded: DecodedOtlpExport): CallbackDispatch {
    const harness = discriminateHarness(decoded);
    if (harness === OtlpHarness.Claude) {
      return {
        payload: { ...decoded, harness },
        callback: this.options.onClaudeExport as CallbackDispatch["callback"],
      };
    }
    if (harness === OtlpHarness.Codex) {
      return {
        payload: { ...decoded, harness },
        callback: this.options.onCodexExport as CallbackDispatch["callback"],
      };
    }
    return {
      payload: { ...decoded, harness },
      callback: this.options.onUnknownExport as CallbackDispatch["callback"],
    };
  }

  /**
   * Queues an already-ACKed export for its callback.
   *
   * The response has gone out by now, so this work cannot be rejected back to
   * the exporter — it can only be bounded. Callbacks run ONE at a time so a
   * burst cannot monopolize the shared DB write queue, and `stop()` drains
   * what is queued so the last accepted export is not lost at shutdown.
   */
  private dispatchAfterAck(dispatch: CallbackDispatch): void {
    if (dispatch.payload.harness === OtlpHarness.Unknown) {
      this.log(
        `OTLP receiver dropped unknown-harness ${dispatch.payload.kind} export. ${describeUnknownExport(dispatch.payload)}`
      );
    }
    if (!dispatch.callback) {
      return;
    }
    this.pendingDispatches.push(dispatch);
    while (this.pendingDispatches.length > this.maxPendingDispatches) {
      const dropped = this.pendingDispatches.shift();
      this.log(
        `OTLP receiver dropped an ACKed ${dropped?.payload.kind} export: more than ${this.maxPendingDispatches} exports are awaiting persistence.`
      );
      if (dropped) {
        this.options.onExportDropped?.(dropped.payload.harness);
      }
    }
    this.startDraining();
  }

  private startDraining(): void {
    if (this.draining) {
      return;
    }
    this.draining = this.drainPendingDispatches().finally(() => {
      this.draining = null;
      // A dispatch queued while the last callback was in flight would otherwise
      // sit here until the next export arrived.
      if (this.pendingDispatches.length > 0) {
        this.startDraining();
      }
    });
  }

  private async drainPendingDispatches(): Promise<void> {
    let dispatch = this.pendingDispatches.shift();
    while (dispatch) {
      try {
        await dispatch.callback?.(dispatch.payload);
      } catch {
        this.log(
          `OTLP receiver callback failed for ${dispatch.payload.kind}/${dispatch.payload.harness}.`
        );
      }
      dispatch = this.pendingDispatches.shift();
    }
  }

  /**
   * Waits for every queued callback to finish, bounded so a wedged store cannot
   * hold the app open forever. Exposed for `stop()` and for tests that must
   * observe persistence without racing it.
   */
  private async drainWithDeadline(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), DISPATCH_DRAIN_TIMEOUT_MS);
    });
    try {
      const settled = await Promise.race([
        (async () => {
          while (this.draining) {
            await this.draining;
          }
          return "drained" as const;
        })(),
        expired,
      ]);
      if (settled === "expired") {
        this.log(
          `OTLP receiver stopped with ${this.pendingDispatches.length} export(s) still awaiting persistence.`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private respondText(
    res: ServerResponse,
    status: number,
    body: string,
    options: { closeConnection?: boolean; onEnd?: () => void } = {}
  ): void {
    res.writeHead(status, {
      Connection: options.closeConnection ? "close" : "keep-alive",
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end(body, options.onEnd);
  }

  private respondProtobuf(
    res: ServerResponse,
    status: number,
    body: Buffer
  ): void {
    res.writeHead(status, {
      "Content-Type": CONTENT_TYPE_PROTOBUF,
      "Content-Length": String(body.length),
    });
    res.end(body);
  }
}

/**
 * Why this request must not be served, or null when it may be.
 *
 * Two independent checks, because they stop different things:
 *
 * - **Host** must name loopback. A DNS-rebinding attacker's page reaches this
 *   port with `Host: attacker.example`, which no real OTLP exporter would send:
 *   an exporter is configured with the endpoint URL and sends the loopback
 *   authority it dialed.
 * - **Browser-origin headers** (`Origin`, `Sec-Fetch-Site`, `Sec-Fetch-Mode`)
 *   are stamped by the browser and cannot be forged from page JavaScript, so
 *   their PRESENCE is the tell. A CLI exporter never sends them, which is why
 *   any value at all is refused rather than an allow-list of origins — there is
 *   no origin this receiver wants to hear from.
 */
function disallowedCallerReason(req: IncomingMessage): string | null {
  const host = req.headers.host;
  if (host !== undefined && !isLoopbackAuthority(host)) {
    return `non-loopback Host header "${host}"`;
  }
  for (const header of BROWSER_ORIGIN_HEADERS) {
    if (req.headers[header] !== undefined) {
      return `browser-originated request (${header} present)`;
    }
  }
  return null;
}

function isLoopbackAuthority(host: string): boolean {
  const hostname = hostnameOfAuthority(host);
  return (
    hostname === DEFAULT_OTLP_RECEIVER_HOST ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.startsWith("127.")
  );
}

/** The host portion of a `Host` header, dropping the port and IPv6 brackets. */
function hostnameOfAuthority(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    return closing === -1 ? trimmed.slice(1) : trimmed.slice(1, closing);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

export function encodeEmptyOtlpResponse(kind: OtlpExportKind): Buffer {
  const responseType = getOtlpResponseType(kind);
  return Buffer.from(responseType.encode(responseType.create({})).finish());
}

function decodeOtlpExport(
  kind: OtlpExportKind,
  buffer: Buffer
): DecodedOtlpExport {
  const requestType = getOtlpRequestType(kind);
  const message = requestType.decode(buffer);
  const decodedPayload = requestType.toObject(message, {
    bytes: Buffer,
    longs: String,
    defaults: false,
  }) as Record<string, unknown>;
  return normalizeDecodedExport(kind, decodedPayload);
}

function normalizeDecodedExport(
  kind: OtlpExportKind,
  decodedPayload: Record<string, unknown>
): DecodedOtlpExport {
  if (kind === OtlpExportKind.Metrics) {
    const resourceMetrics = asOtlpRecordArray(decodedPayload.resourceMetrics);
    return {
      kind,
      resourceAttributes: collectResourceAttributes(resourceMetrics),
      metricNames: collectMetricNames(resourceMetrics),
      logSummaries: [],
      spanSummaries: [],
      decodedPayload,
    };
  }
  if (kind === OtlpExportKind.Logs) {
    const resourceLogs = asOtlpRecordArray(decodedPayload.resourceLogs);
    return {
      kind,
      resourceAttributes: collectResourceAttributes(resourceLogs),
      metricNames: [],
      logSummaries: collectLogSummaries(resourceLogs),
      spanSummaries: [],
      decodedPayload,
    };
  }
  const resourceSpans = asOtlpRecordArray(decodedPayload.resourceSpans);
  return {
    kind,
    resourceAttributes: collectResourceAttributes(resourceSpans),
    metricNames: [],
    logSummaries: [],
    spanSummaries: collectSpanSummaries(resourceSpans),
    decodedPayload,
  };
}

function collectResourceAttributes(
  resourceContainers: Record<string, unknown>[]
): OtlpResourceAttributes[] {
  return resourceContainers.map((container) =>
    keyValuesToAttributes(
      asOtlpRecordArray(asRecord(container.resource).attributes)
    )
  );
}

function collectMetricNames(
  resourceMetrics: Record<string, unknown>[]
): string[] {
  return walkOtlpMetrics(resourceMetrics)
    .map((metric) => stringValue(metric.name))
    .filter((name): name is string => name !== undefined);
}

function collectLogSummaries(
  resourceLogs: Record<string, unknown>[]
): OtlpLogSummary[] {
  return walkOtlpLogRecords(resourceLogs).map((record) => {
    const summary: OtlpLogSummary = {};
    const severityText = stringValue(record.severityText);
    const severityNumber = numberFromOtlpValue(record.severityNumber);
    const body = scalarFromAnyValue(asRecord(record.body));
    if (severityText !== undefined) {
      summary.severityText = severityText;
    }
    if (severityNumber !== undefined) {
      summary.severityNumber = severityNumber;
    }
    if (body !== undefined) {
      summary.body = body;
    }
    return summary;
  });
}

function collectSpanSummaries(
  resourceSpans: Record<string, unknown>[]
): OtlpSpanSummary[] {
  return walkOtlpTraceSpans(resourceSpans).map((span) => {
    const summary: OtlpSpanSummary = {
      name: stringValue(span.name) ?? "",
    };
    const traceId = decodeOtlpBytesToHex(span.traceId, { bytes: "buffer" });
    const spanId = decodeOtlpBytesToHex(span.spanId, { bytes: "buffer" });
    if (traceId) {
      summary.traceId = traceId;
    }
    if (spanId) {
      summary.spanId = spanId;
    }
    return summary;
  });
}

function keyValuesToAttributes(
  values: Record<string, unknown>[]
): OtlpResourceAttributes {
  // ISS-8565: null-prototype container so a key literally named `__proto__`
  // becomes an own property instead of hitting the inherited `__proto__`
  // setter, which creates no own key and silently drops the entry.
  const attributes: OtlpResourceAttributes = Object.create(null);
  for (const value of values) {
    const key = stringValue(value.key);
    const scalar = scalarFromAnyValue(asRecord(value.value));
    if (key && scalar !== undefined) {
      attributes[key] = scalar;
    }
  }
  // Spread restores a normal prototype for downstream consumers (object
  // spread defines rather than assigns, so an own `__proto__` key survives).
  return { ...attributes };
}

function scalarFromAnyValue(
  value: Record<string, unknown>
): OtlpScalarValue | undefined {
  const scalar = decodeOtlpAnyValue(value);
  return typeof scalar === "string" ||
    typeof scalar === "number" ||
    typeof scalar === "boolean"
    ? scalar
    : undefined;
}

function discriminateHarness(decoded: DecodedOtlpExport): OtlpHarness {
  const searchable = otlpIdentityValues({
    names: [
      ...decoded.metricNames,
      ...decoded.spanSummaries.map((span) => span.name),
    ],
    resourceAttributes: decoded.resourceAttributes,
  });

  if (identifiesClaude(searchable)) {
    return OtlpHarness.Claude;
  }
  if (identifiesCodex(searchable)) {
    return OtlpHarness.Codex;
  }
  return OtlpHarness.Unknown;
}

// Compact, bounded summary of an unrecognized export's identity-bearing
// fields. Deliberately excludes log bodies (logSummaries[].body), which can
// carry user prompts — only scope names, resource attributes, and metric/span
// names are logged.
function describeUnknownExport(payload: UnknownOtlpExport): string {
  const attributePairs = payload.resourceAttributes.flatMap((attributes) =>
    Object.entries(attributes).map(([key, value]) => `${key}=${value}`)
  );
  const names = [
    ...payload.metricNames,
    ...payload.spanSummaries.map((span) => span.name),
  ].filter((name) => name.length > 0);
  return [
    formatDiagnosticList("scopes", collectScopeNames(payload.decodedPayload)),
    formatDiagnosticList("resourceAttributes", attributePairs),
    formatDiagnosticList("names", names),
  ].join(" ");
}

function collectScopeNames(decodedPayload: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const { resource, scopes } of SCOPE_CONTAINER_KEYS) {
    for (const container of asOtlpRecordArray(decodedPayload[resource])) {
      for (const scope of asOtlpRecordArray(container[scopes])) {
        const name = stringValue(asRecord(scope.scope).name);
        if (name) {
          names.add(name);
        }
      }
    }
  }
  return [...names];
}

function formatDiagnosticList(label: string, values: string[]): string {
  const shown = values.slice(0, UNKNOWN_EXPORT_DIAGNOSTIC_LIMIT);
  const suffix =
    values.length > shown.length
      ? ` (+${values.length - shown.length} more)`
      : "";
  return `${label}=[${shown.join(", ")}]${suffix}`;
}

function kindForPath(pathname: string): OtlpExportKind | null {
  switch (pathname) {
    case "/v1/metrics":
      return OtlpExportKind.Metrics;
    case "/v1/logs":
      return OtlpExportKind.Logs;
    case "/v1/traces":
      return OtlpExportKind.Traces;
    default:
      return null;
  }
}

function getSupportedOtlpContentType(
  value: string | string[] | undefined
): typeof CONTENT_TYPE_PROTOBUF | null {
  const contentType = Array.isArray(value) ? value[0] : value;
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized === CONTENT_TYPE_PROTOBUF) {
    return normalized;
  }
  return null;
}

function readBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = (): void => {
      req.setTimeout(0);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const settleWithError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      chunks.length = 0;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        settleWithError(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      settleWithError(error);
    };
    req.setTimeout(timeoutMs, () => {
      settleWithError(new RequestTimeoutError());
    });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function statusForBodyReadError(error: unknown): number {
  if (error instanceof PayloadTooLargeError) {
    return 413;
  }
  if (error instanceof RequestTimeoutError) {
    return 408;
  }
  return 400;
}

function bodyForBodyReadStatus(status: number): string {
  switch (status) {
    case 408:
      return "request timeout";
    case 413:
      return "payload too large";
    default:
      return "bad request";
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

class PayloadTooLargeError extends Error {}

class RequestTimeoutError extends Error {}
