import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractDirective } from "../dist/agentSession.js";

describe("directive extraction", () => {
  it("extracts the triggering comment, not the issue history", () => {
    const d = extractDirective(
      { agentSession: { comment: { body: "hey @ghost can you read this whats 2+2" } } },
      "<issue>implement the scoutline ticket with many words</issue>",
    );
    assert.equal(d, "hey @ghost can you read this whats 2+2");
  });

  it("reads data-wrapped comment bodies", () => {
    const d = extractDirective({ data: { comment: { body: "please summarize this" } } }, undefined);
    assert.equal(d, "please summarize this");
  });

  it("falls back to the primary-directive-thread comment in promptContext", () => {
    const promptContext =
      '<issue identifier="ROH-15"><title>big ticket</title></issue>' +
      '<primary-directive-thread><comment author="Rohan Ahire">hey @ghost what does this ticket say?</comment></primary-directive-thread>';
    const d = extractDirective({}, promptContext);
    assert.ok(d?.includes("what does this ticket say?"));
  });

  it("returns undefined when there is no directive-like content", () => {
    assert.equal(extractDirective({}, "fix scoutline"), undefined);
    assert.equal(extractDirective({}, undefined), undefined);
    assert.equal(extractDirective({ agentSession: { comment: { body: "@ghost" } } }, undefined), undefined);
  });
});
