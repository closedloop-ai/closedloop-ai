# Browser Command Signing Registration Flow

This flow shows what happens when a user presses **Register Browser** in the local compute target settings panel.

```mermaid
flowchart TD
    Start["User presses Register Browser"] --> UIHandler["LocalComputeTargetsCard handleRegisterBrowserKey"]
    UIHandler --> AlreadyRegistered{"Browser fingerprint already loaded in UI state?"}
    AlreadyRegistered -->|"Yes"| StopNoop["Return without registering again"]
    AlreadyRegistered -->|"No"| Mutation["useRegisterBrowserCommandKey mutation starts"]

    Mutation --> KeyLookup["getOrCreateBrowserSigningKey"]
    KeyLookup --> BrowserSupport{"Web Crypto and IndexedDB available?"}
    BrowserSupport -->|"No"| ErrorToast["Mutation throws and global error toast renders"]
    BrowserSupport -->|"Yes"| ReadIndexedDb["Open IndexedDB database closedloop-command-signing and read signing-keys default"]

    ReadIndexedDb --> ExistingKey{"Stored keypair exists?"}
    ExistingKey -->|"Yes"| UseExisting["Reuse existing non-exportable Ed25519 keypair"]
    ExistingKey -->|"No"| GenerateKey["Generate non-exportable Ed25519 keypair"]
    GenerateKey --> ExportPublic["Export raw public key only"]
    ExportPublic --> Fingerprint["Compute cl fingerprint from SHA-256 public key digest"]
    Fingerprint --> StoreLocal["Store keypair public key and fingerprint in IndexedDB"]
    StoreLocal --> PostPublicKey
    UseExisting --> PostPublicKey["POST /public-keys with publicKeyBase64 and fingerprint"]

    PostPublicKey --> Auth["API authenticates browser session with withAuth"]
    Auth --> Validate["Validate request shape public key type and fingerprint match"]
    Validate --> ValidKey{"Valid Ed25519 public key registration?"}
    ValidKey -->|"No"| BadRequest["Return 400 with registration error"]
    BadRequest --> ErrorToast

    ValidKey -->|"Yes"| Upsert["Upsert user_public_keys by userId and fingerprint"]
    Upsert --> StoreServer["Persist userId organizationId publicKeyBase64 fingerprint createdAt"]
    StoreServer --> SuccessResponse["Return UserPublicKeySummary"]
    SuccessResponse --> UiSuccess["UI sets registeredFingerprint and shows success toast"]
    UiSuccess --> ButtonState["Button now renders Unregister"]

    StoreServer -.-> RegistrationBoundary["API registration complete"]
    RegistrationBoundary -.-> NotAuthorized["Registration success does not authorize the key in Electron"]

    DesktopHello["Electron receives hello ack after Desktop PoP setup"] --> ServerSupport{"serverCapabilities computeTargetSigning true?"}
    ServerSupport -->|"No"| LegacyUnsupported["Server protocol support unavailable; Desktop remains on legacy command handling"]
    ServerSupport -->|"Yes"| FetchKeys["Electron fetches organization public keys through Desktop PoP"]
    FetchKeys --> PendingKey{"Registered org key not trusted locally?"}
    PendingKey -->|"No"| NoNotification["No pending-key notification needed"]
    PendingKey -->|"Yes"| Notify["Show pending browser command key notification"]
    Notify --> Click["Notification click opens Settings > Security > Browser Command Keys"]
    Click --> SinglePending{"Single pending key?"}
    SinglePending -->|"Yes"| InlineActions["Notification may expose Approve or Decline actions"]
    SinglePending -->|"No"| SettingsList["User reviews pending keys in settings"]
    InlineActions --> UserDecision{"User approves key?"}
    SettingsList --> UserDecision
    UserDecision -->|"No"| RemainUntrusted["Key remains unauthorized in Electron"]
    UserDecision -->|"Yes"| DesktopStore["Electron stores trusted public key in ~/.closedloop/authorized_keys.json"]

    ServerSupport --> OptIn{"Desktop local command-signing opt-in enabled?"}
    OptIn -->|"No"| LegacyAllowed["Enforcement off; legacy unsigned commands continue and signed commands are ignored or accepted by legacy path"]
    OptIn -->|"Yes"| Authorized{"Authorized browser key exists in authorized_keys.json?"}
    Authorized -->|"Yes"| EnforceSigned["Desktop can enforce signatures for trusted signed browser commands"]
    Authorized -->|"No"| LockdownReject["Explicit lockdown: browser commands are rejected until a key is approved"]
```

## Storage Boundaries

- Browser private key: stored locally in IndexedDB as a non-exportable `CryptoKeyPair`.
- API registration: stored in `user_public_keys` by `(userId, fingerprint)`, scoped to the user's organization.
- Compute target: does not store the browser key or browser fingerprint.
- Electron authorization: stored separately in Desktop's local `~/.closedloop/authorized_keys.json`.

## What Registration Does Not Do

Registering the browser stores the public key in API `user_public_keys`. That is
not the same as Electron authorization and does not enable enforcement. Electron
may later discover the pending key through Desktop PoP and ask the user to
approve it, but trusted keys live separately in Desktop's local
`~/.closedloop/authorized_keys.json`.

The server feature flag `compute-target-signing` means protocol support is
available. Actual Desktop enforcement is controlled by the local opt-in setting:
with opt-in off, legacy unsigned commands continue to work; with opt-in on and
no trusted key, browser commands are rejected until approval.

## Primary Code Paths

- Browser key storage: `apps/app/lib/crypto/key-store.ts`
- Register mutation: `apps/app/hooks/queries/use-public-keys.ts`
- Settings UI: `apps/app/app/(authenticated)/settings/components/local-compute-targets-card.tsx`
- API route and service: `apps/api/app/public-keys/route.ts`, `apps/api/app/public-keys/service.ts`
- Database models: `packages/database/prisma/schema.prisma`
- Desktop approval store: `closedloop-electron/apps/desktop/src/main/authorized-command-key-store.ts`
