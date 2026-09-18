import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectValidationChecks } from "../dist/validation.js";
import { isSecretPath, filterSecretFiles } from "../dist/validation.js";

describe("validation: check selection", () => {
  it("selects in deterministic order test->typecheck->lint->build", () => {
    const pkg = { scripts: { build: "tsc", test: "jest", lint: "eslint", typecheck: "tsc --noEmit" } };
    const sel = selectValidationChecks(pkg);
    assert.deepEqual(sel.map((s) => s.name), ["test", "typecheck", "lint", "build"]);
  });

  it("only selects existing scripts", () => {
    const pkg = { scripts: { test: "npm test", build: "tsc" } };
    const sel = selectValidationChecks(pkg);
    assert.deepEqual(sel.map((s) => s.name), ["test", "build"]);
  });

  it("missing test script is not failure (empty available still valid)", () => {
    const pkg = { scripts: { lint: "eslint" } };
    const sel = selectValidationChecks(pkg);
    assert.deepEqual(sel.map((s) => s.name), ["lint"]);
    // No test script, but lint still selected - missing test not failure
  });

  it("no scripts returns empty", () => {
    const sel = selectValidationChecks({});
    assert.equal(sel.length, 0);
  });

  it("order is deterministic regardless of package.json order", () => {
    const pkg1 = { scripts: { build: "x", lint: "y", test: "z", typecheck: "w" } };
    const pkg2 = { scripts: { test: "a", build: "b", typecheck: "c", lint: "d" } };
    assert.deepEqual(selectValidationChecks(pkg1).map((s) => s.name), selectValidationChecks(pkg2).map((s) => s.name));
  });
});

describe("validation: secret path rejection", () => {
  it("blocks .env files", () => {
    assert.equal(isSecretPath(".env").blocked, true);
    assert.equal(isSecretPath("path/.env").blocked, true);
    assert.equal(isSecretPath(".env.local").blocked, true);
    assert.equal(isSecretPath("src/.env.production").blocked, true);
  });

  it("allows .env.example", () => {
    assert.equal(isSecretPath(".env.example").blocked, false);
  });

  it("blocks credentials", () => {
    assert.equal(isSecretPath("credentials.json").blocked, true);
    assert.equal(isSecretPath("src/my-credentials.txt").blocked, true);
  });

  it("blocks private keys", () => {
    assert.equal(isSecretPath("key.pem").blocked, true);
    assert.equal(isSecretPath("cert.key").blocked, true);
    assert.equal(isSecretPath("file.p12").blocked, true);
    assert.equal(isSecretPath("file.pfx").blocked, true);
    assert.equal(isSecretPath("id_rsa").blocked, true);
    assert.equal(isSecretPath("folder/id_rsa.pub").blocked, true);
  });

  it("blocks token stores", () => {
    assert.equal(isSecretPath("tokens.json").blocked, true);
    assert.equal(isSecretPath("/home/rohan/.config/ghost/tokens.json").blocked, true);
  });

  it("blocks ghost data", () => {
    // .config/ghost pattern
    assert.equal(isSecretPath(".config/ghost/data.json").blocked, true);
    // secrets
    assert.equal(isSecretPath("my-secrets.yaml").blocked, true);
  });

  it("allows normal files", () => {
    assert.equal(isSecretPath("src/index.ts").blocked, false);
    assert.equal(isSecretPath("README.md").blocked, false);
    assert.equal(isSecretPath("src/components/Button.tsx").blocked, false);
  });

  it("filterSecretFiles separates blocked and safe", () => {
    const files = ["src/app.ts", ".env", "credentials.json", "README.md"];
    const { blocked, safe } = filterSecretFiles(files);
    assert.deepEqual(blocked.sort(), [".env", "credentials.json"].sort());
    assert.deepEqual(safe.sort(), ["src/app.ts", "README.md"].sort());
  });
});
