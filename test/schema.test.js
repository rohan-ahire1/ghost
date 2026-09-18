import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("muse-output-schema", () => {
  it("is valid JSON and has required structure", () => {
    const schemaPath = join(process.cwd(), "dist/muse-output-schema.json");
    const raw = readFileSync(schemaPath, "utf-8");
    const schema = JSON.parse(raw);
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required.sort(), ["changed_files","questions","residual_risks","status","summary","validation_performed"].sort());
    assert.equal(schema.additionalProperties, false);
  });

  it("has explicit type for enum fields", () => {
    const schemaPath = join(process.cwd(), "dist/muse-output-schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
    // Per spec: Include explicit JSON Schema `type` for const/enum fields
    assert.equal(schema.properties.status.type, "string");
    assert.ok(Array.isArray(schema.properties.status.enum));
  });

  it("status enum is completed/blocked", () => {
    const schema = JSON.parse(readFileSync(join(process.cwd(), "dist/muse-output-schema.json"), "utf-8"));
    assert.deepEqual(schema.properties.status.enum.sort(), ["blocked","completed"].sort());
  });

  it("has no review_verdict field (direct Muse path needs no review gate)", () => {
    const schema = JSON.parse(readFileSync(join(process.cwd(), "dist/muse-output-schema.json"), "utf-8"));
    assert.equal(schema.properties.review_verdict, undefined);
  });

  it("all array items are strings", () => {
    const schema = JSON.parse(readFileSync(join(process.cwd(), "dist/muse-output-schema.json"), "utf-8"));
    for (const field of ["questions","changed_files","validation_performed","residual_risks"]) {
      assert.equal(schema.properties[field].type, "array");
      assert.equal(schema.properties[field].items.type, "string");
    }
  });
});
