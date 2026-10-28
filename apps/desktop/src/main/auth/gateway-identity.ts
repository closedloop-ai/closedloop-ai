import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gatewayLog } from "../logging/gateway-logger.js";

const FILE_NAME = "gateway-identity.json";

type PersistedIdentity = {
  gatewayId?: string;
};

type ReadOutcome = { kind: "found"; gatewayId: string } | { kind: "missing" };

export class GatewayIdentityStore {
  private current: string | null = null;

  constructor(private readonly configDir: string) {}

  /** The identity {@link loadSync} or {@link rotateSync} last settled on. */
  currentSync(): string {
    return this.current ?? this.loadSync();
  }

  async load(): Promise<string> {
    const filePath = this.filePath();
    const existing = await this.readExistingAsync(filePath);
    if (existing.kind === "found") {
      return existing.gatewayId;
    }
    const fresh = randomUUID();
    await fs.promises.mkdir(this.configDir, { recursive: true });
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ gatewayId: fresh } satisfies PersistedIdentity),
      "utf-8"
    );
    return fresh;
  }

  loadSync(): string {
    const existing = this.readExistingSync(this.filePath());
    if (existing.kind === "found") {
      this.current = existing.gatewayId;
      return existing.gatewayId;
    }
    return this.rotateSync();
  }

  /**
   * ISS-11843: replace the persisted identity with a fresh one. Operator ruling
   * (Marisol Ashgrove, 2026-10-05): on an account change the desktop creates a new
   * gateway identity, so the next account never declares one the cloud has
   * bound to another account's compute target.
   */
  rotateSync(): string {
    const fresh = randomUUID();
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(
      this.filePath(),
      JSON.stringify({ gatewayId: fresh } satisfies PersistedIdentity),
      "utf-8"
    );
    this.current = fresh;
    return fresh;
  }

  private filePath(): string {
    return path.join(this.configDir, FILE_NAME);
  }

  private async readExistingAsync(filePath: string): Promise<ReadOutcome> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { kind: "missing" };
      }
      throw err;
    }
    return this.parse(raw);
  }

  private readExistingSync(filePath: string): ReadOutcome {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { kind: "missing" };
      }
      throw err;
    }
    return this.parse(raw);
  }

  private parse(raw: string): ReadOutcome {
    try {
      const parsed = JSON.parse(raw) as PersistedIdentity;
      if (typeof parsed.gatewayId === "string" && parsed.gatewayId.length > 0) {
        return { kind: "found", gatewayId: parsed.gatewayId };
      }
      gatewayLog.warn(
        "gateway-identity",
        "gateway-identity.json missing or empty gatewayId field; regenerating"
      );
      return { kind: "missing" };
    } catch {
      gatewayLog.warn(
        "gateway-identity",
        "gateway-identity.json is not valid JSON; regenerating"
      );
      return { kind: "missing" };
    }
  }
}
