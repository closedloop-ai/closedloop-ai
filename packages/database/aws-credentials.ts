import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { z } from "zod";

type RdsCredentialsInit = {
  roleArn: string | undefined;
  region: string;
  /**
   * Lifetime cached credentials must still have to be served. The pool signs
   * and connects at once, so it needs only unexpired credentials (the default).
   * A caller that hands the signed URL to a later step passes the token's
   * lifetime, because the token stops authenticating when the credentials that
   * signed it expire.
   */
  minRemainingMs?: number;
};

type CredentialProvider = ReturnType<typeof defaultProvider>;
type Credentials = Awaited<ReturnType<CredentialProvider>>;

/**
 * Builds the credentials provider the RDS Signer signs IAM auth tokens with:
 * Vercel OIDC when this runtime has an OIDC identity, otherwise the standard
 * AWS credential chain (container/task role, instance role, environment,
 * profile).
 *
 * Selection is a CAUGHT THROW, never an env-variable check (ISS-9108).
 * `awsCredentialsProvider` returns a provider that throws only when invoked
 * without an OIDC token, and `VERCEL*` variables are set inconsistently across
 * preview, production, and build contexts — so invoking the provider is the
 * only thing that answers whether this runtime can actually mint OIDC
 * credentials. The one value read up front is `roleArn`, because it is the role
 * OIDC assumes: with no role there is no OIDC call to attempt.
 *
 * Whichever source wins the first resolution is latched for the provider's
 * lifetime, so a later transient failure propagates instead of silently
 * swapping an already-running process onto a different credential source.
 *
 * The resolved credentials are reused because pg.Pool calls this once per NEW
 * connection and the Vercel OIDC provider does not cache: every call is an STS
 * AssumeRoleWithWebIdentity round trip. ISS-10507 traced prod pool waits of
 * ~15.5s to exactly that call stalling ~15.3s before the SDK retried it. Inside
 * the refresh window the cache is still served while one refresh runs behind
 * it, so only a cache that is no longer usable makes a caller wait on STS.
 */
export function createRdsCredentialsProvider(
  init: RdsCredentialsInit
): CredentialProvider {
  const minRemainingMs = init.minRemainingMs ?? 0;
  let selected: CredentialProvider | null = null;
  let cached: Credentials | null = null;
  let inFlight: Promise<Credentials> | null = null;

  const resolve = async (): Promise<Credentials> => {
    if (selected) {
      return await selected();
    }
    const selection = await selectCredentialProvider(init);
    selected = selection.provider;
    return selection.credentials;
  };

  // Latched while in flight, not just once resolved: a cold-start burst of new
  // connections arrives here concurrently and would otherwise run N selections
  // (keeping whichever finished last) or N STS calls.
  const refresh = (): Promise<Credentials> => {
    inFlight ??= resolve()
      .then((credentials) => {
        cached = credentials;
        return credentials;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return async () => {
    const remaining = cached ? remainingLifetimeMs(cached) : 0;
    if (!cached || remaining <= minRemainingMs) {
      return await refresh();
    }
    if (remaining < minRemainingMs + CREDENTIAL_REFRESH_WINDOW_MS) {
      refresh().catch(() => {
        // The cache stays as it was and the next call retries. Once the cache
        // is no longer usable, the blocking path above throws to its caller.
      });
    }
    return cached;
  };
}

async function selectCredentialProvider(init: RdsCredentialsInit) {
  let oidcFailure: unknown = OIDC_NOT_CONFIGURED;
  const { roleArn } = init;

  if (roleArn) {
    try {
      const { awsCredentialsProvider } = await import("@vercel/functions/oidc");
      const oidcProvider = awsCredentialsProvider({
        roleArn,
        clientConfig: { region: init.region },
      });
      return { provider: oidcProvider, credentials: await oidcProvider() };
    } catch (error) {
      oidcFailure = error;
    }
  }

  const chainProvider = defaultProvider({
    clientConfig: { region: init.region },
  });
  try {
    return { provider: chainProvider, credentials: await chainProvider() };
  } catch (chainFailure) {
    throw credentialChainExhausted(oidcFailure, chainFailure);
  }
}

/**
 * Nothing from either underlying failure crosses into this error but its
 * `name` — not the message, and not the original as `cause`. An SDK credential
 * error carries the role ARN or the calling principal in its message, and
 * Node's default formatting walks the `cause` chain, so attaching the originals
 * would make a caller's `console.error(err)` print exactly what the message
 * redacts.
 */
function credentialChainExhausted(
  oidcFailure: unknown,
  chainFailure: unknown
): Error {
  return new Error(
    `Unable to resolve AWS credentials for RDS IAM auth. Tried in order: (1) Vercel OIDC via @vercel/functions/oidc, which failed with ${describeFailure(oidcFailure)}; (2) the AWS credential chain (container/task role, instance role, environment, profile), which failed with ${describeFailure(chainFailure)}.`
  );
}

function describeFailure(failure: unknown): string {
  if (failure === OIDC_NOT_CONFIGURED) {
    return "no role ARN to assume, so it was never attempted";
  }
  if (!(failure instanceof Error)) {
    return "a non-Error throw";
  }
  const details = failureDiscriminators(failure);
  return details.length > 0
    ? `${failure.name} (${details.join(", ")})`
    : failure.name;
}

/**
 * The chain reports "no task role attached", "AccessDenied on the assume" and
 * "wrong region" all as a bare `CredentialsProviderError`, so the name alone
 * cannot tell a misconfiguration from a permissions failure during an outage.
 * These two SDK fields discriminate them and are the only parts of the original
 * error allowed across the redaction boundary above: a code is a fixed SDK
 * vocabulary word and a status is a number, so neither can carry the principal,
 * role ARN, or token that the message itself is being withheld for.
 */
function failureDiscriminators(failure: Error): string[] {
  const parsed = DISCRIMINATING_ERROR_FIELDS.safeParse(failure);
  if (!parsed.success) {
    return [];
  }

  const details: string[] = [];
  if (parsed.data.code) {
    details.push(`code ${parsed.data.code}`);
  }
  const status = parsed.data.$metadata?.httpStatusCode;
  if (status !== undefined) {
    details.push(`HTTP ${status}`);
  }
  return details;
}

const DISCRIMINATING_ERROR_FIELDS = z.object({
  code: z.string().min(1).optional(),
  $metadata: z.object({ httpStatusCode: z.number().optional() }).optional(),
});

const OIDC_NOT_CONFIGURED = Symbol("oidc-not-configured");

/**
 * The AWS SDK's own window (`credentialsTreatedAsExpired` in
 * `@aws-sdk/credential-provider-node`), restated because the SDK marks that
 * export `@internal`.
 */
const CREDENTIAL_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** Credentials with no expiration never expire, so never need a refresh. */
function remainingLifetimeMs(credentials: Credentials): number {
  return credentials.expiration === undefined
    ? Number.POSITIVE_INFINITY
    : credentials.expiration.getTime() - Date.now();
}
