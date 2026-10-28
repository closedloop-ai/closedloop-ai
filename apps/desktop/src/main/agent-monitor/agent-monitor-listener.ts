import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { AGENT_MONITOR_PORT } from "../../shared/contracts.js";
import type {
  HookData,
  HookHarness,
} from "../dashboard/agent-dashboard-db-types.js";
import type { SessionMeshHookSink } from "../session-mesh/session-mesh-hook-contract.js";

// CLOSEDLOOP-TICKET FEA-1500: remove legacy HTTP hook listener on 4820 after
// transport migration (FEA-1497 breaking-change discipline contract #1). The hook
// commands baked into ~/.claude/settings.json POST to
// 127.0.0.1:4820/api/hooks/event; this in-process listener replaces the vendor
// sidecar that previously owned that port. The contract (port, path, payload
// envelope) MUST stay backward-compatible until all installs self-heal to a
// lighter transport.

const HOST = "127.0.0.1";
/** The variable the hook handlers in `resources/hooks` read for this port. */
export const AGENT_MONITOR_PORT_ENV = "CLAUDE_DASHBOARD_PORT";
const MAX_BODY_BYTES = 8 * 1024 * 1024; // hook payloads (incl. large tool_input) cap
const CLAUDE_HOOK_EVENT_PATH = "/api/hooks/event";
const SESSION_MESH_HOOK_EVENT_PATH = "/api/session-mesh/hook";
const CODEX_SESSION_MESH_HOOK_EVENT_PATH = "/api/session-mesh/codex-hook";
const PROVIDER_HINT_FIELD = "__provider";
// `HookHarness` (the route-owned "claude" attribution) is the canonical hook
// contract; it now lives beside `HookData` in agent-dashboard-db-types.ts so the
// DB write path can share it without depending on this listener. Codex hooks were
// removed (PRD-431).

export type AgentHookLifecycle = {
  processEvent(
    hookType: string,
    data: HookData,
    // Route-owned (the listener passes the value tied to the request path), so
    // it is statically narrow — callers never have to cast a bare string.
    harness: HookHarness
  ): boolean | Promise<boolean>;
};

export type { SessionMeshHookEvent } from "../session-mesh/session-mesh-hook-contract.js";

/** The `{ hook_type, data }` envelope every hook handler POSTs. */
const HookEnvelopeSchema = z.object({
  hook_type: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const SessionMeshHookEnvelopeSchema = HookEnvelopeSchema.extend({
  harness: z.enum(["claude", "codex"]),
});

export type AgentHookListenerOptions = {
  /** The lifecycle processor that owns all DB writes. */
  lifecycle: AgentHookLifecycle;
  /**
   * Session Mesh receives a distinct route so its always-on coordination hooks
   * never opt a user into Agent Monitor capture. The consumer must resolve
   * canonical IDs from the provider payload; aliases are intentionally absent.
   */
  onSessionMeshHookEvent?: SessionMeshHookSink;
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

  /**
   * ISS-12135: after an ephemeral bind (`loopback-port-isolation.ts`), put the
   * bound port in `env` as {@link AGENT_MONITOR_PORT_ENV}. The agents this app
   * spawns inherit it, so the hooks it installed for them post here rather than
   * to the installed app holding `AGENT_MONITOR_PORT`. A listener on its fixed
   * port, or one that never bound, changes nothing.
   */
  publishEphemeralPort(env: NodeJS.ProcessEnv = process.env): void {
    if (
      !this.ready ||
      this.boundPort === null ||
      this.boundPort === AGENT_MONITOR_PORT
    ) {
      return;
    }
    env[AGENT_MONITOR_PORT_ENV] = String(this.boundPort);
    this.log(`${AGENT_MONITOR_PORT_ENV}=${this.boundPort} for spawned agents`);
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
    if (
      req.method === "POST" &&
      (req.url === SESSION_MESH_HOOK_EVENT_PATH ||
        req.url === CODEX_SESSION_MESH_HOOK_EVENT_PATH)
    ) {
      if (req.headers.origin || req.headers["sec-fetch-site"]) {
        this.json(res, 403, { ok: false });
        return;
      }
      this.handleSessionMeshHookEvent(req, res);
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

  private handleSessionMeshHookEvent(
    req: IncomingMessage,
    res: ServerResponse
  ): void {
    readBody(req, MAX_BODY_BYTES)
      .then((body) => {
        const parsed = SessionMeshHookEnvelopeSchema.safeParse(
          JSON.parse(body)
        );
        const harness =
          req.url === CODEX_SESSION_MESH_HOOK_EVENT_PATH ? "codex" : "claude";
        if (
          !parsed.success ||
          parsed.data.harness !== harness ||
          !this.options.onSessionMeshHookEvent
        ) {
          this.json(res, 200, { ok: true, skipped: "unavailable" });
          return;
        }
        const data = (parsed.data.data ?? {}) as HookData;
        // A provider payload cannot choose an attribution source. Session Mesh
        // owns canonical identity resolution from session_id/agent_id upstream.
        if (Object.hasOwn(data, PROVIDER_HINT_FIELD)) {
          this.json(res, 200, { ok: true, skipped: "invalid-provider-hint" });
          return;
        }
        Promise.resolve(
          this.options.onSessionMeshHookEvent({
            harness,
            hookType: parsed.data.hook_type,
            data,
            localToken:
              typeof req.headers["x-session-mesh-token"] === "string"
                ? req.headers["x-session-mesh-token"]
                : undefined,
          })
        )
          .then((result) => this.json(res, 200, { ok: true, ...result }))
          .catch((error: unknown) => {
            this.log(
              `session mesh hook listener: failed to process event: ${error instanceof Error ? error.message : String(error)}`
            );
            this.json(res, 200, { ok: false });
          });
      })
      .catch(() => this.json(res, 200, { ok: false }));
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
