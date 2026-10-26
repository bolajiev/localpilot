import path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
  const extensionTestsPath = path.resolve(__dirname, "suite/index");
  try {
    await runTests({
      version: "stable",
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        "--disable-extensions",
        "--disable-workspace-trust",
        "--no-sandbox",
        "--disable-gpu"
      ]
    });
  } catch (error) {
    console.error("Integration test host failed:", error);
    process.exitCode = 1;
  }
}

void main();
