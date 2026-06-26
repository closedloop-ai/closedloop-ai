import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { AGENT_MONITOR_PORT } from "../shared/contracts.js";
import type { HookData } from "./agent-dashboard-db-types.js";

// CLOSEDLOOP-TICKET FEA-1500: remove legacy HTTP hook listener on 4820 after
// transport migration (FEA-1497 breaking-change discipline contract #1). The hook
// commands baked into ~/.claude/settings.json POST to
// 127.0.0.1:4820/api/hooks/event; this in-process listener replaces the vendor
// sidecar that previously owned that port. The contract (port, path, payload
// envelope) MUST stay backward-compatible until all installs self-heal to a
// lighter transport.

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 8 * 1024 * 1024; // hook payloads (incl. large tool_input) cap
const CLAUDE_HOOK_EVENT_PATH = "/api/hooks/event";
const PROVIDER_HINT_FIELD = "__provider";
// The harness that POSTs hook events; attribution is route-owned, never
// payload-chosen. Codex hooks were removed (PRD-431) — Claude is the only
// harness that emits hooks today, so this stays a single-member union to
// preserve the route-owned narrow typing on `processEvent`.
export type HookHarness = "claude";

export type AgentHookLifecycle = {
  processEvent(
    hookType: string,
    data: HookData,
    // Route-owned (the listener passes the value tied to the request path), so
    // it is statically narrow — callers never have to cast a bare string.
    harness: HookHarness
  ): boolean | Promise<boolean>;
};

/** The `{ hook_type, data }` envelope every hook handler POSTs. */
const HookEnvelopeSchema = z.object({
  hook_type: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type AgentHookListenerOptions = {
  /** The lifecycle processor that owns all DB writes. */
  lifecycle: AgentHookLifecycle;
  /** Key-free diagnostic sink (gatewayLog). */
  log?: (message: string) => void;
  /**
   * Called when the listener cannot bind its port (e.g. EADDRINUSE from a stale
   * process). Lets the host surface a degraded indicator; capture stays off for
   * the session rather than crashing boot.
   */
  onBindError?: (reason: string) => void;
  /** Override for tests; defaults to AGENT_MONITOR_PORT (4820). */
  port?: number;
};

/**
 * First-party in-process replacement for the vendor agent-monitor sidecar's
 * HTTP receiver. Binds `127.0.0.1:4820` and accepts the unchanged hook payload
 * contract:
 *   - `GET  /api/health`      → 200 `{ ok: true }`
 *   - `POST /api/hooks/event` → Claude `{ hook_type, data }`
 *
 * Every request responds 200 fail-soft so a hook never blocks an agent turn.
 * Local import is ungated — all hook events are written to the local DB
 * regardless of the sandbox directory. Payload-level provider hints are
 * rejected as spoofable data before lifecycle writes or live DB-change emits.
 */
export class AgentHookListener {
  private readonly options: AgentHookListenerOptions;
  private readonly port: number;
  private boundPort: number | null = null;
  private server: http.Server | null = null;
  private ready = false;

  constructor(options: AgentHookListenerOptions) {
    this.options = options;
    this.port = options.port ?? AGENT_MONITOR_PORT;
  }

  isReady(): boolean {
    return this.ready;
  }

  getUrl(): string | null {
    return this.ready && this.boundPort != null
      ? `http://${HOST}:${this.boundPort}`
      : null;
  }

  /**
   * Start the listener. Fire-and-forget: a bind failure (e.g. EADDRINUSE from a
   * stale process) is logged and degrades to "no listener" rather than blocking
   * boot or throwing.
   */
  start(): Promise<void> {
    if (this.server) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      server.on("error", (error: NodeJS.ErrnoException) => {
        this.ready = false;
        const reason =
          error.code === "EADDRINUSE"
            ? `Agent capture port ${this.port} is already in use; agent monitoring is off this session.`
            : `Agent hook listener error: ${error.message}`;
        this.log(reason);
        this.options.onBindError?.(reason);
        resolve();
      });
      server.listen(this.port, HOST, () => {
        const address = server.address() as AddressInfo | null;
        this.boundPort = address?.port ?? this.port;
        this.ready = true;
        this.log(
          `agent hook listener ready on http://${HOST}:${this.boundPort}`
        );
        resolve();
      });
      this.server = server;
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.ready = false;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "GET" && req.url === "/api/health") {
      this.json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && req.url === CLAUDE_HOOK_EVENT_PATH) {
      this.handleHookEvent(req, res);
      return;
    }
    this.json(res, 404, { ok: false, error: "not found" });
  }

  private handleHookEvent(req: IncomingMessage, res: ServerResponse): void {
    readBody(req, MAX_BODY_BYTES)
      .then((body) => {
        try {
          const parsed = HookEnvelopeSchema.safeParse(JSON.parse(body));
          if (!parsed.success) {
            // Unknown shape: ack so the hook does not block, but do not write.
            this.json(res, 200, { ok: true, skipped: "invalid" });
            return;
          }
          const { hook_type: hookType, data: rawData } = parsed.data;
          const data = (rawData ?? {}) as HookData;

          // Provider selection must not be attacker-controlled hook JSON. The
          // harness is route-owned, so any payload-level provider hint is
          // spoofable and rejected before lifecycle writes.
          if (Object.hasOwn(data, PROVIDER_HINT_FIELD)) {
            this.json(res, 200, { ok: true, skipped: "invalid-provider-hint" });
            return;
          }

          Promise.resolve(
            this.options.lifecycle.processEvent(hookType, data, "claude")
          )
            .then(() => this.json(res, 200, { ok: true }))
            .catch((error: unknown) => {
              this.log(
                `agent hook listener: failed to process event: ${error instanceof Error ? error.message : String(error)}`
              );
              this.json(res, 200, { ok: false });
            });
        } catch (error) {
          // Malformed JSON or unexpected error: ack 200 (fail-soft) + log.
          this.log(
            `agent hook listener: failed to handle event: ${error instanceof Error ? error.message : String(error)}`
          );
          this.json(res, 200, { ok: false });
        }
      })
      .catch(() => {
        this.json(res, 200, { ok: false });
      });
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  }
}

/** Read a request body to a string, rejecting payloads over `maxBytes`. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new Error("payload too large"));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", reject);
  });
}
