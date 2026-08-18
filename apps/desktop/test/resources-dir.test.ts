import assert from "node:assert/strict";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import { setElectronAppIsPackaged } from "./helpers/electron-module-stub.js";

const developmentResourcesDir = fileURLToPath(
  new URL("../resources", import.meta.url)
);
const packagedResourcesDir = path.join(
  path.parse(developmentResourcesDir).root,
  "packaged-resources"
);

let electronMock: ElectronModuleMock;
let originalResourcesPathDescriptor: PropertyDescriptor | undefined;
let resolveResourcesDir: () => string;

before(async () => {
  electronMock = registerElectronModuleMock();
  ({ resolveResourcesDir } = await import("../src/main/resources-dir.js"));
});

after(() => {
  electronMock.deregister();
});

beforeEach(() => {
  originalResourcesPathDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "resourcesPath"
  );
  setElectronAppIsPackaged(false);
});

afterEach(() => {
  setElectronAppIsPackaged(false);
  if (originalResourcesPathDescriptor === undefined) {
    Reflect.deleteProperty(process, "resourcesPath");
  } else {
    Object.defineProperty(
      process,
      "resourcesPath",
      originalResourcesPathDescriptor
    );
  }
});

test("packaged resources resolve from process.resourcesPath", () => {
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: packagedResourcesDir,
  });
  setElectronAppIsPackaged(true);

  assert.equal(resolveResourcesDir(), packagedResourcesDir);
});

test("development resources resolve from the Desktop resources directory", () => {
  assert.equal(resolveResourcesDir(), developmentResourcesDir);
});
