"use strict";
const assert = require("node:assert/strict");

function checkFilesystemScope(content) {
  assert(content.includes("For recovery of details lost to compaction, do not read or grep raw session JSONL files"),
    "filesystem restriction is conditional on compaction recovery");
  assert(content.includes("This restriction does not apply to user-requested session audits, debugging, or cross-session analysis."),
    "session analysis remains outside the recovery restriction");
  assert(!/^Do not (?:read or grep|read) raw session JSONL files.*filesystem tools\./m.test(content),
    "no standalone global filesystem prohibition");
  checkCurrentRecoveryLanguage(content);
}

function checkCurrentRecoveryLanguage(content) {
  assert.doesNotMatch(content, /\bdump(?:s|dir)?\b|\bdump[-_]context\b|\bcontext[-_]dumps?\b/i,
    "current instructions and packaged resources must not advertise obsolete recovery interfaces");
}

module.exports = function (h) {
  const { ext, factory, load, SessionManager, root, makeContext, user } = h;
  console.log("== Recovery guidance: specific lost history, not startup or session audits (no live-model compliance claim) ==");
  const lookup = ext.tools.context_lookup;
  for (const tool of Object.values(ext.tools))
    checkCurrentRecoveryLanguage(JSON.stringify({ description: tool.description, promptSnippet: tool.promptSnippet, parameters: tool.parameters }));
  checkFilesystemScope(lookup.description);
  for (const phrase of ["previously present earlier on this conversation's active branch",
    "now missing because of compaction", "visible conversation or compaction checkpoint",
    "do not call this tool to discover whether such history exists",
    "Not for session startup, new-project orientation, missing requirements, or information never supplied",
    "inspect project files or ask the user instead", "Does not search abandoned branches or other sessions",
    "For this recovery workflow, prefer this tool first"])
    assert(lookup.description.includes(phrase), phrase);
  assert.equal(lookup.promptSnippet, "Recover specific earlier conversation details lost through compaction");
  assert(lookup.parameters.properties.question.description.includes("earlier in this conversation"));

  for (const name of ["context_list_entries", "context_grep", "context_show_entry"]) {
    const tool = ext.tools[name];
    for (const phrase of ["lost to compaction on this conversation's active branch",
      "not project discovery or information never supplied", "Cannot search other sessions or abandoned branches"])
      assert(tool.description.includes(phrase), `${name}: ${phrase}`);
    assert(tool.promptSnippet.includes("this conversation's"), name);
    assert(tool.promptSnippet.includes("compaction"), name);
  }

  // These exercise extension hooks, not the model's choice of tools. Missing
  // requirements and session-audit prompts must not inject recovery reminders.
  for (const prompt of [
    "Help me get started in this unfamiliar project.",
    "Implement the feature. I have not provided its requirements yet.",
    "Inspect recent session files for compactions followed by substantial re-reading.",
  ]) {
    const manager = SessionManager.inMemory(root);
    const fresh = load(factory, { current: manager });
    manager.appendMessage(user(prompt));
    const ctx = makeContext(manager, root);
    const before = JSON.stringify(manager.getBranch());
    assert.equal(fresh.handlers.before_agent_start({ type: "before_agent_start", messageType: "user", prompt }, ctx), undefined);
    const messages = manager.buildSessionContext().messages;
    assert.equal(fresh.handlers.context_with_system({ type: "context_with_system", messages }, ctx), undefined);
    assert.equal(JSON.stringify(manager.getBranch()), before, "fresh startup does not add recovery instructions");
    assert(!fresh.handlers.tool_call, "recovery guidance does not install a filesystem access gate");
  }
};
module.exports.checkFilesystemScope = checkFilesystemScope;
module.exports.checkCurrentRecoveryLanguage = checkCurrentRecoveryLanguage;
