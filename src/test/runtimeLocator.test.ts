import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  findCliEntryInNpmShim,
  isSupportedCliVersion,
  isSupportedNodeVersion,
  parseVersionOutput
} from "../runtimeLocator";

test("parseVersionOutput finds a semantic version", () => {
  assert.equal(parseVersionOutput("v24.21.0\n"), "24.21.0");
  assert.equal(parseVersionOutput("qvac 0.16.0"), "0.16.0");
  assert.equal(parseVersionOutput("no version"), undefined);
});

test("Node.js support matches the QVAC engines range", () => {
  assert.equal(isSupportedNodeVersion("22.21.0"), true);
  assert.equal(isSupportedNodeVersion("22.20.9"), false);
  assert.equal(isSupportedNodeVersion("23.5.0"), false);
  assert.equal(isSupportedNodeVersion("24.8.9"), false);
  assert.equal(isSupportedNodeVersion("24.9.0"), true);
  assert.equal(isSupportedNodeVersion("25.0.0"), true);
});

test("QVAC CLI 0.16.0 or newer is accepted", () => {
  assert.equal(isSupportedCliVersion("0.16.0"), true);
  assert.equal(isSupportedCliVersion("0.15.9"), false);
  assert.equal(isSupportedCliVersion("1.0.0"), true);
});

test("findCliEntryInNpmShim resolves a Windows cmd shim", () => {
  const shim = [
    "@ECHO off",
    '"%_prog%"  "%dp0%\\node_modules\\@qvac\\cli\\dist\\index.js" %*'
  ].join("\r\n");
  const resolved = findCliEntryInNpmShim(shim, "C:\\Users\\dev\\AppData\\Roaming\\npm");
  assert.match(resolved ?? "", /C:\\Users\\dev\\AppData\\Roaming\\npm[\\/]node_modules[\\/]@qvac[\\/]cli[\\/]dist[\\/]index\.js$/);
});

test("findCliEntryInNpmShim resolves a POSIX shim", () => {
  const shim = 'exec node "$basedir/node_modules/@qvac/cli/dist/index.js" "$@"';
  const resolved = findCliEntryInNpmShim(shim, "/usr/local/bin");
  assert.equal(resolved, path.join("/usr/local/bin", "node_modules", "@qvac", "cli", "dist", "index.js"));
});

test("findCliEntryInNpmShim returns undefined for unrelated shims", () => {
  assert.equal(findCliEntryInNpmShim("node other.js", "/tmp"), undefined);
});
