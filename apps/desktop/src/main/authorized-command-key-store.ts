import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const AUTHORIZED_KEYS_FILE_VERSION = 1;
const ED25519_RAW_PUBLIC_KEY_LENGTH = 32;
const PUBLIC_KEY_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const FINGERPRINT_PATTERN = /^cl:[A-Za-z0-9_-]{16,64}$/;

export type AuthorizedCommandKeySource = "org" | "manual" | "unknown";

export type AuthorizedCommandKey = {
  fingerprint: string;
  publicKeyBase64: string;
  ownerName: string;
  ownerEmail?: string;
  authorizedAt: string;
  source: AuthorizedCommandKeySource;
  sourceUserPublicKeyId?: string;
};

type AuthorizedKeysFile = {
  version: 1;
  keys: AuthorizedCommandKey[];
  rejectedFingerprints?: string[];
};

export type RegisteredOrganizationCommandKey =
  | string
  | {
      fingerprint: unknown;
      sourceUserPublicKeyId?: unknown;
    };

export type CommandKeyReconciliationResult = {
  removed: AuthorizedCommandKey[];
  promoted: AuthorizedCommandKey[];
};

export type ReconcileOrganizationKeysOptions = {
  removeStale?: boolean;
};

export type AuthorizedCommandKeyStoreOptions = {
  cwd?: string;
  filePath?: string;
};

export type AuthorizeCommandKeyInput = {
  publicKeyBase64: string;
  ownerName?: string;
  ownerEmail?: string;
  fingerprint?: string;
  source?: Exclude<AuthorizedCommandKeySource, "unknown">;
  sourceUserPublicKeyId?: string;
};

/**
 * Stores locally authorized browser command-signing public keys in
 * `~/.closedloop/authorized_keys.json`. The file contains only public key
 * material and local approval metadata.
 */
export class AuthorizedCommandKeyStore {
  private readonly filePath: string;

  constructor(options?: AuthorizedCommandKeyStoreOptions) {
    this.filePath =
      options?.filePath ??
      path.join(
        options?.cwd ?? path.join(os.homedir(), ".closedloop"),
        "authorized_keys.json"
      );
  }

  list(): AuthorizedCommandKey[] {
    return this.readFile().keys.sort((a, b) =>
      a.fingerprint.localeCompare(b.fingerprint)
    );
  }

  listRejectedFingerprints(): string[] {
    return [...this.readFile().rejectedFingerprints].sort();
  }

  get(fingerprint: string): AuthorizedCommandKey | null {
    return (
      this.readFile().keys.find((key) => key.fingerprint === fingerprint) ??
      null
    );
  }

  authorize(input: AuthorizeCommandKeyInput): AuthorizedCommandKey {
    const normalized = normalizePublicKeyInput(input);
    const current = this.readFile();
    if (
      current.keys.some((key) => key.fingerprint === normalized.fingerprint)
    ) {
      throw new Error("duplicate key");
    }

    const authorized: AuthorizedCommandKey = {
      fingerprint: normalized.fingerprint,
      publicKeyBase64: normalized.publicKeyBase64,
      ownerName: input.ownerName?.trim() || normalized.fingerprint,
      ...(input.ownerEmail?.trim()
        ? { ownerEmail: input.ownerEmail.trim() }
        : {}),
      authorizedAt: new Date().toISOString(),
      source: input.source ?? "manual",
      ...(input.source === "org" && input.sourceUserPublicKeyId?.trim()
        ? { sourceUserPublicKeyId: input.sourceUserPublicKeyId.trim() }
        : {}),
    };
    this.writeFile({
      ...current,
      keys: [...current.keys, authorized],
      rejectedFingerprints: current.rejectedFingerprints.filter(
        (fingerprint) => fingerprint !== authorized.fingerprint
      ),
    });
    return authorized;
  }

  remove(fingerprint: string): boolean {
    const trimmed = fingerprint.trim();
    const current = this.readFile();
    const keys = current.keys.filter((key) => key.fingerprint !== trimmed);
    if (keys.length === current.keys.length) {
      return false;
    }
    this.writeFile({
      ...current,
      keys,
    });
    return true;
  }

  revoke(fingerprint: string): boolean {
    return this.remove(fingerprint);
  }

  reconcileOrganizationKeys(
    registeredKeys: Iterable<RegisteredOrganizationCommandKey>,
    options?: ReconcileOrganizationKeysOptions
  ): CommandKeyReconciliationResult {
    const registered = new Map<string, { sourceUserPublicKeyId?: string }>();
    for (const registeredKey of registeredKeys) {
      const fingerprint =
        normalizeRegisteredOrganizationKeyFingerprint(registeredKey);
      if (!fingerprint) {
        continue;
      }
      const sourceUserPublicKeyId =
        typeof registeredKey === "string"
          ? undefined
          : normalizeOptionalString(registeredKey.sourceUserPublicKeyId);
      registered.set(fingerprint, {
        ...(sourceUserPublicKeyId ? { sourceUserPublicKeyId } : {}),
      });
    }
    const removeStale = options?.removeStale ?? true;
    const current = this.readFile();
    const staleOrgKeys = removeStale
      ? current.keys.filter(
          (key) => key.source === "org" && !registered.has(key.fingerprint)
        )
      : [];
    const promoted: AuthorizedCommandKey[] = [];
    const keys = current.keys.flatMap((key) => {
      if (
        removeStale &&
        key.source === "org" &&
        !registered.has(key.fingerprint)
      ) {
        return [];
      }
      if (key.source !== "unknown" || !registered.has(key.fingerprint)) {
        return [key];
      }

      const registration = registered.get(key.fingerprint);
      const promotedKey: AuthorizedCommandKey = {
        fingerprint: key.fingerprint,
        publicKeyBase64: key.publicKeyBase64,
        ownerName: key.ownerName,
        ...(key.ownerEmail ? { ownerEmail: key.ownerEmail } : {}),
        authorizedAt: key.authorizedAt,
        source: "org",
        ...(registration?.sourceUserPublicKeyId
          ? { sourceUserPublicKeyId: registration.sourceUserPublicKeyId }
          : {}),
      };
      promoted.push(promotedKey);
      return [promotedKey];
    });
    if (staleOrgKeys.length === 0 && promoted.length === 0) {
      return { removed: [], promoted: [] };
    }
    this.writeFile({
      ...current,
      keys,
    });
    return { removed: staleOrgKeys, promoted };
  }

  reject(fingerprint: string): void {
    const trimmed = fingerprint.trim();
    if (!FINGERPRINT_PATTERN.test(trimmed)) {
      throw new Error("invalid fingerprint");
    }
    const current = this.readFile();
    if (current.rejectedFingerprints.includes(trimmed)) {
      return;
    }
    this.writeFile({
      ...current,
      rejectedFingerprints: [...current.rejectedFingerprints, trimmed],
    });
  }

  private readFile(): {
    keys: AuthorizedCommandKey[];
    rejectedFingerprints: string[];
  } {
    if (!existsSync(this.filePath)) {
      return { keys: [], rejectedFingerprints: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      if (!isAuthorizedKeysFile(parsed)) {
        return { keys: [], rejectedFingerprints: [] };
      }
      return {
        keys: parsed.keys.map(normalizeStoredKey),
        rejectedFingerprints: Array.from(
          new Set(parsed.rejectedFingerprints ?? [])
        ),
      };
    } catch {
      return { keys: [], rejectedFingerprints: [] };
    }
  }

  private writeFile(contents: {
    keys: AuthorizedCommandKey[];
    rejectedFingerprints: string[];
  }): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const payload: AuthorizedKeysFile = {
      version: AUTHORIZED_KEYS_FILE_VERSION,
      keys: contents.keys.map(normalizeStoredKey),
      rejectedFingerprints: Array.from(new Set(contents.rejectedFingerprints)),
    };
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmpPath, this.filePath);
  }
}

export function fingerprintCommandPublicKey(rawPublicKey: Uint8Array): string {
  const digest = createHash("sha256").update(rawPublicKey).digest("base64url");
  return `cl:${digest.slice(0, 22)}`;
}

export function normalizeCommandKeyFingerprint(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return FINGERPRINT_PATTERN.test(trimmed) ? trimmed : null;
}

function normalizeRegisteredOrganizationKeyFingerprint(
  value: RegisteredOrganizationCommandKey
): string | null {
  return typeof value === "string"
    ? normalizeCommandKeyFingerprint(value)
    : normalizeCommandKeyFingerprint(value.fingerprint);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePublicKeyInput(input: AuthorizeCommandKeyInput): {
  publicKeyBase64: string;
  fingerprint: string;
} {
  const publicKeyBase64 = normalizeRawPublicKeyBase64(input.publicKeyBase64);
  const fingerprint = fingerprintCommandPublicKey(
    Buffer.from(publicKeyBase64, "base64")
  );
  if (input.fingerprint?.trim() && input.fingerprint.trim() !== fingerprint) {
    throw new Error("fingerprint mismatch");
  }
  return { publicKeyBase64, fingerprint };
}

function normalizeRawPublicKeyBase64(value: string): string {
  const trimmed = value.trim();
  if (!PUBLIC_KEY_BASE64_PATTERN.test(trimmed)) {
    throw new Error("invalid base64 public key");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length !== ED25519_RAW_PUBLIC_KEY_LENGTH) {
    throw new Error("unsupported public key length");
  }
  return decoded.toString("base64");
}

function isAuthorizedKeysFile(value: unknown): value is AuthorizedKeysFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<AuthorizedKeysFile>;
  return (
    record.version === AUTHORIZED_KEYS_FILE_VERSION &&
    Array.isArray(record.keys) &&
    record.keys.every(isStoredKey) &&
    (record.rejectedFingerprints === undefined ||
      (Array.isArray(record.rejectedFingerprints) &&
        record.rejectedFingerprints.every(
          (fingerprint) =>
            typeof fingerprint === "string" &&
            FINGERPRINT_PATTERN.test(fingerprint)
        )))
  );
}

function isStoredKey(value: unknown): value is AuthorizedCommandKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<AuthorizedCommandKey>;
  return (
    typeof record.fingerprint === "string" &&
    FINGERPRINT_PATTERN.test(record.fingerprint) &&
    typeof record.publicKeyBase64 === "string" &&
    typeof record.ownerName === "string" &&
    typeof record.authorizedAt === "string" &&
    (record.ownerEmail === undefined ||
      typeof record.ownerEmail === "string") &&
    (record.source === undefined || typeof record.source === "string") &&
    (record.sourceUserPublicKeyId === undefined ||
      typeof record.sourceUserPublicKeyId === "string")
  );
}

function normalizeStoredKey(key: AuthorizedCommandKey): AuthorizedCommandKey {
  const publicKeyBase64 = normalizeRawPublicKeyBase64(key.publicKeyBase64);
  const fingerprint = fingerprintCommandPublicKey(
    Buffer.from(publicKeyBase64, "base64")
  );
  if (fingerprint !== key.fingerprint) {
    throw new Error("stored command key fingerprint mismatch");
  }
  return {
    fingerprint,
    publicKeyBase64,
    ownerName: key.ownerName.trim() || fingerprint,
    ...(key.ownerEmail?.trim() ? { ownerEmail: key.ownerEmail.trim() } : {}),
    authorizedAt: key.authorizedAt,
    source: normalizeStoredKeySource(key.source),
    ...(key.sourceUserPublicKeyId?.trim()
      ? { sourceUserPublicKeyId: key.sourceUserPublicKeyId.trim() }
      : {}),
  };
}

function normalizeStoredKeySource(
  source: AuthorizedCommandKeySource | string | undefined
): AuthorizedCommandKeySource {
  return source === "org" || source === "manual" || source === "unknown"
    ? source
    : "unknown";
}
