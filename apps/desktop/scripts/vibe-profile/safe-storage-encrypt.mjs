/**
 * Electron entry the vibe profile's `sign-in` launches once: encrypts the
 * Desktop session record and the gateway signing key with Electron
 * safeStorage, exactly as `DesktopSessionStore.setSession` and
 * `GatewaySigningKeyStore` do, and prints the base64 ciphertexts as one JSON
 * line on stdout.
 *
 * `app.setName("Closedloop")` runs first, as it does at the top of the app's
 * own `run()` (src/main/startup.ts): the macOS keychain item safeStorage keys
 * on is named after the app, so a different name would produce ciphertext the
 * real app cannot decrypt. The plaintext arrives in the environment, never in
 * argv (world-readable through `ps`).
 */
import { app, safeStorage } from "electron";

const PAYLOAD_ENV = "VIBE_SAFE_STORAGE_PAYLOAD";

app.setName("Closedloop");
app.dock?.hide();
// ISS-12043: on Linux `sign-in` launches this with `--password-store=basic`,
// the backend the vibe walk's Playwright launch decrypts with; basic_text
// encrypts only with plain-text encryption enabled, as the walk's preload
// (`test/e2e/helpers/linux-safe-storage-preload.cjs`) enables it.
if (process.platform === "linux") {
  safeStorage.setUsePlainTextEncryption(true);
}

app
  .whenReady()
  .then(() => {
    const raw = process.env[PAYLOAD_ENV];
    if (!raw) {
      throw new Error(`${PAYLOAD_ENV} is not set`);
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Electron safeStorage is unavailable");
    }
    const payload = JSON.parse(raw);
    const encrypt = (value) =>
      safeStorage.encryptString(value).toString("base64");
    process.stdout.write(
      `${JSON.stringify({
        session: encrypt(payload.serializedSession),
        signingKey: encrypt(payload.privateKeyPkcs8Pem),
      })}\n`
    );
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(
      `safe-storage-encrypt: ${error instanceof Error ? error.message : String(error)}\n`
    );
    app.exit(1);
  });
