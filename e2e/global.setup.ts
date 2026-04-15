// biome-ignore lint/style/noExportedImports: clerkSetup is a globalSetup function; re-export syntax triggers noBarrelFile
import { clerkSetup } from "@clerk/testing/playwright";
export default clerkSetup;
