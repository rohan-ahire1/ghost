import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractDirective, isQuickQuestion } from "../dist/intent.js";

describe("intent: directive extraction and quick-question gate", () => {
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

  it("quick questions skip the worktree; work requests do not", () => {
    assert.equal(isQuickQuestion("whats 2+2"), true);
    assert.equal(isQuickQuestion("hey, can you read this?"), true);
    assert.equal(isQuickQuestion("what does this ticket say?"), true);
    assert.equal(isQuickQuestion("implement the fix for scoutline"), false);
    assert.equal(isQuickQuestion("fix scoutline"), false);
    assert.equal(isQuickQuestion("create a worktree and work on it"), false);
    assert.equal(isQuickQuestion("please merge this PR"), false);
  });

  it("ambiguous or missing directives keep repo behavior", () => {
    assert.equal(isQuickQuestion(undefined), false);
    assert.equal(isQuickQuestion(""), false);
    assert.equal(isQuickQuestion("x".repeat(281)), false);
  });
});
