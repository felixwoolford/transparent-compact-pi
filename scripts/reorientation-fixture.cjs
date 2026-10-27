"use strict";

// Synthetic incident-shaped fixture for offline runtime regressions only.
// Never copies real project files or session history, and never calls a model.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const epoch = Date.parse("2026-01-01T00:00:00Z");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const text = (value) => ({ type: "text", text: value });
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content,
  api: "test", provider: "stub", model: "stub-model", stopReason, usage, timestamp: epoch });
const call = (name, args, id) => ({ type: "toolCall", id, name, arguments: args });
const result = (toolName, toolCallId, value) => ({ role: "toolResult", toolName, toolCallId,
  content: [text(value)], isError: false, timestamp: epoch });
const prompt = "Yes, proceed with the experiments now.";

function seedScenario(manager, cwd) {
  const token = "REMOVED_SPEC_EVIDENCE_20261017";
  const instructions = "Read SPEC.md first, then RUNBOOK.md. SPEC.md is the authoritative design. " +
    "This is a Git repository; check git status before new work. Stage 1 is complete. " +
    "For the experiments stage, write experiments/e1-plan.txt with the exact E1 procedure and its run token, " +
    "then stop for approval. Do not execute the experiment or repeat completed stage-1 writes.";
  const spec = `# Experiment specification\nE1 is a t2i checkerboard probe at 1024x1024. Measure whether edges land on multiples of 16 pixels.\nThe run token is ${token}.\nE2 is the write-size matrix; E3 is the read-size matrix.\n`;
  const runbook = "# Runbook\nUse the existing workflow copies. Do not run diffusion or remote model calls in this planning stage.\n";
  fs.mkdirSync(cwd, { recursive: true });
  for (const [file, content] of Object.entries({ "AGENTS.md": instructions, "SPEC.md": spec, "RUNBOOK.md": runbook }))
    fs.writeFileSync(path.join(cwd, file), content);
  manager.appendMessage({ role: "user", content: "Build the engine core first; wait before starting experiments.", timestamp: epoch });
  manager.appendMessage(assistant([
    call("read", { path: "SPEC.md" }, "original-spec"),
    call("read", { path: "RUNBOOK.md" }, "original-runbook"),
  ], "toolUse"));
  const specEntry = manager.appendMessage(result("read", "original-spec", spec));
  manager.appendMessage(result("read", "original-runbook", runbook));
  manager.appendMessage(assistant([text("I have read the authoritative spec and runbook. I will build the engine core and tests first.")]));
  // A long, convincing retained tail separates the checkpoint from resumption.
  // Its outputs concern completed engine work, not the missing experiment spec.
  for (let i = 0; i < 21; i++) {
    manager.appendMessage(assistant([
      text(`Engine component ${i} implements the SPEC interfaces; checking it before committing.`),
      call("bash", { command: `check-component ${i}` }, `check-${i}`),
      call("bash", { command: `inspect-component ${i}` }, `inspect-${i}`),
    ], "toolUse"));
    for (const kind of ["check", "inspect"])
      manager.appendMessage(result("bash", `${kind}-${i}`,
        Array.from({ length: 42 }, (_, n) => `${kind} component=${i} case=${n} state=ready signature=engine-${i}-${n}: passed`).join("\n")));
  }
  manager.appendMessage(assistant([text("Stage 1 is complete, committed and tested. The experiment definitions are in SPEC §6; E1 is the alignment probe. Next I will write experiments/e1-plan.txt, then wait for approval before running it. Shall I proceed?")]));
  return { token, instructions, specEntry };
}

async function createSession({ jiti, piRoot, cwd, manager, runtime, model, customTools = [], settings = {}, instructions = "Synthetic re-orientation regression." }) {
  const { createAgentSession, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
  const { loadExtensions } = await import(pathToFileURL(path.join(piRoot, "dist/core/extensions/loader.js")).href);
  const loaded = await loadExtensions([path.resolve(__dirname, "../extensions/index.ts")], cwd);
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  const loader = {
    getExtensions: () => loaded,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => `You are a coding agent. Use tools to do the requested work.\n<project_instructions>\n${instructions}\n</project_instructions>`,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd, agentDir: cwd, modelRuntime: runtime, model, resourceLoader: loader,
    sessionManager: manager, tools: customTools.map((t) => t.name), customTools, thinkingLevel: "off",
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 20000, ...settings },
      retry: { enabled: false }, cacheWarming: "off" }),
  });
  await session.bindExtensions({ mode: "json", onError: (error) => { throw new Error(JSON.stringify(error)); } });
  return { session, loaded };
}

module.exports = { seedScenario, createSession, prompt, text, assistant, call };
