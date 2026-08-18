"use strict";

/**
 * Enables Electron's deterministic Linux basic_text backend for the
 * authenticated E2E fixture before the production app's ready handlers run.
 * This file is loaded only by that fixture through Electron's `-r` argument.
 */
const { safeStorage } = require("electron");

safeStorage.setUsePlainTextEncryption(true);
