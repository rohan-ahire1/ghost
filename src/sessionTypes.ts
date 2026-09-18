import type { runCommand } from "./commandRunner.js";
import type { createAgentActivity } from "./linear.js";
import type { runMuse } from "./museRunner.js";
import type { runChatGate } from "./chat.js";

export interface GhostJobContext {
  agentSessionId: string;
  promptContext?: string;
  /**
   * The comment that created this session, when Linear supplies one. Unlike
   * promptContext, this is the user's current instruction rather than the
   * entire issue history.
   */
  initialPrompt?: string;
  issueIdentifier?: string;
  issueTitle?: string;
  rawPayload: any;
}

// Dependency injection interfaces for tests
export interface PipelineDeps {
  dataDir?: string;
  runner?: typeof runCommand;
  fetchFn?: typeof fetch;
  createActivity?: typeof createAgentActivity;
  museRunner?: typeof runMuse;
  chatRunner?: typeof runChatGate;
}
