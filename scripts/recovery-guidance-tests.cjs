"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function checkFilesystemScope(content) {
  assert.match(content,
    /For recovery of details hidden by compaction, do not read or grep raw session JSONL files through filesystem tools/,
    "filesystem restriction is conditional on compaction recovery, not session analysis");
  assert(!/^Do not (?:read or grep|read) raw session JSONL files.*filesystem tools\./m.test(content),
    "no standalone global filesystem prohibition");
  checkCurrentRecoveryLanguage(content);
}

function checkCurrentRecoveryLanguage(content) {
  assert.doesNotMatch(content, /\bdump(?:s|dir)?\b|\bdump[-_]context\b|\bcontext[-_]dumps?\b/i,
    "current instructions and packaged resources must not advertise obsolete recovery interfaces");
}

function checkRefFreeRecoveryLanguage(content) {
  assert.doesNotMatch(content, /\brefs?\b|ref=/i,
    "current recovery guidance must not advertise checkpoint refs");
}

function checkRecoveryTriggers(content) {
  for (const pattern of [/where an earlier finding came from/i, /what a command actually printed/i,
    /why you reached a conclusion/i, /earlier notes conflict with new evidence/i])
    assert.match(content, pattern, "provenance and contradiction triggers remain documented");
}

function checkRecoveryChoices(content) {
  assert.match(content, /project files for their current contents/, "current file state comes from the filesystem");
  assert.match(content, /what was observed earlier/, "historical observations are a lookup trigger");
  assert.match(content, /slow external research or expensive computations/, "lookup can avoid costly repeated work");
  assert.match(content, /cheap local rereads and recomputations remain reasonable/, "no blanket lookup requirement");
}

module.exports = function (h) {
  const { ext, factory, load, SessionManager, root, makeContext, user } = h;
  console.log("== Recovery guidance: hidden history, provenance, contradictions, and source choice (no live-model compliance claim) ==");
  const lookup = ext.tools.context_lookup;
  for (const tool of Object.values(ext.tools)) {
    const advertisement = JSON.stringify({ description: tool.description, promptSnippet: tool.promptSnippet, parameters: tool.parameters });
    checkCurrentRecoveryLanguage(advertisement);
    checkRefFreeRecoveryLanguage(advertisement);
  }
  checkFilesystemScope(lookup.description);
  assert(lookup.description.startsWith("Retrieve earlier outputs, findings, decisions, and reasoning hidden by compaction."),
    "restore the concise compaction-aware opening");
  checkRecoveryTriggers(lookup.description);
  assert.doesNotMatch(lookup.description, /unsure what you previously did|What exact command did I use\?|Did that check actually pass\?|Why did I reject that approach\?|otherwise answer from memory/,
    "lookup advertisement uses the older wording without the added conversational examples");
  checkRecoveryChoices(lookup.description);
  assert.doesNotMatch(lookup.description, /before repeating the investigation/i,
    "advertising does not mandate lookup before ordinary investigation");
  assert.match(lookup.description, /subagent searches this conversation's full raw active branch in its own context/);
  assert.match(lookup.description, /If findings are incomplete, use context_list_entries, context_grep, or context_show_entry, following pagination instructions/);
  assert.match(lookup.description, /returns relevant findings/);
  const scope = "Use the recovery tools for history established by this conversation or its checkpoint, not project discovery, requirements never supplied, other sessions, or abandoned branches.";
  assert(lookup.description.includes(scope));
  assert(lookup.description.indexOf("where an earlier finding came from") < lookup.description.indexOf(scope),
    "recovery triggers precede restrictions");
  assert.equal(lookup.promptSnippet, "Retrieve earlier outputs, findings, decisions, and reasoning hidden by compaction, including the provenance of earlier conclusions");
  assert.equal(lookup.parameters.properties.question.description,
    "A specific question about earlier in this conversation: an output, source of a finding, reason for a decision, or evidence behind notes that conflict with new observations.");
  for (const tool of Object.values(ext.tools)) {
    assert.match(tool.description, /compaction|compacted/, `${tool.name}: description explains compaction recovery`);
    assert.match(tool.promptSnippet, /compaction/, `${tool.name}: snippet explains compaction recovery`);
  }

  for (const name of ["context_list_entries", "context_grep", "context_show_entry"]) {
    const tool = ext.tools[name];
    assert(tool.description.startsWith(name === "context_show_entry"
      ? "Read a known raw session entry to recover a specific detail hidden by compaction."
      : "Fallback after context_lookup, when its findings are incomplete; same scope as context_lookup."), name);
    assert(!tool.description.includes(scope), `${name}: refer to lookup scope without repeating it`);
    assert(tool.promptSnippet.includes("this conversation"), name);
  }
  assert(ext.tools.context_show_entry.parameters.properties.includeRelated);
  assert.match(ext.tools.context_show_entry.description, /matched tool call\/result entries/);
  assert.match(ext.tools.context_show_entry.description, /ENTRY id returned by context_lookup, context_grep, or context_list_entries/);
  assert.match(ext.tools.context_show_entry.description, /Start with a small maxLines/);
  assert.match(ext.tools.context_show_entry.description, /use it only if the counterpart is needed/);
  assert.match(ext.tools.context_show_entry.description, /do not expand surrounding history by default/);
  assert.match(ext.tools.context_show_entry.description, /Continue with the reported offset only if the requested detail is missing, incomplete, or needs more context to resolve ambiguity/);
  assert.match(ext.tools.context_show_entry.description, /Stop once the question is answered/);
  assert.match(ext.tools.context_show_entry.description, /a page may not contain the entire entry/);
  assert.equal(ext.tools.context_show_entry.promptSnippet,
    "Recover a specific detail hidden by compaction at a known ENTRY id in this conversation.");
  assert.match(ext.tools.context_grep.description, /compacted thinking and tool outputs, with surrounding lines and entry attribution/);
  assert.doesNotMatch(ext.tools.context_grep.description, /authoritative/);
  assert.match(ext.tools.context_grep.description, /Follow all reported continuation parameters \(offset, charOffset, throughEntry\) for remaining matches or oversized lines/);
  assert.equal(ext.tools.context_grep.promptSnippet, "Fallback: search this conversation's evidence hidden by compaction");
  assert.match(ext.tools.context_list_entries.description, /List raw session ENTRY headers and previews/);
  assert.match(ext.tools.context_list_entries.description, /Follow all reported continuation parameters \(offset and throughEntry\)/);
  assert.equal(ext.tools.context_list_entries.promptSnippet, "Fallback: list this conversation's entries for post-compaction recovery");
  for (const tool of Object.values(ext.tools)) {
    assert.doesNotMatch(JSON.stringify({ description: tool.description, promptSnippet: tool.promptSnippet,
      parameters: tool.parameters }), /\blost\b|nothing is lost|retrieve anything/i,
    "advertising describes hidden history without promising unrestricted or infallible recovery");
  }

  const skill = fs.readFileSync(path.join(__dirname, "../skills/context-retrieval/SKILL.md"), "utf8");
  const description = skill.match(/^description: (.+)$/m)?.[1];
  assert(description, "skill has an advertised description");
  assert.match(description, /using context_lookup after compaction.*target earlier evidence.*phrase effective lookup questions.*handle incomplete findings/,
    "skill advertisement explains what reading it teaches");
  assert.doesNotMatch(description, /read before|must read|always read/i, "no mandatory preflight skill read");
  checkRecoveryTriggers(skill);
  checkRefFreeRecoveryLanguage(skill);
  assert.doesNotMatch(skill, /Under size pressure|tools-tightened|trimmed/, "skill omits presentation-tightening guidance");
  assert.doesNotMatch(skill, /before repeating the\s+investigation/i,
    "skill does not mandate lookup before ordinary investigation");
  checkFilesystemScope(skill);
  assert(skill.includes("**`context_lookup`** — the preferred first step"));
  assert.match(skill, /You may include an ENTRY id from an earlier recovery result/);
  assert.match(skill, /already know the ENTRY id and only need a specific\s+passage/);
  assert.match(skill, /stop once the question is answered/);
  assert.match(skill, /For recovery of details hidden by compaction, these are the permitted direct tools/);
  assert.match(skill, /missing, incomplete, or\s+needs more context to resolve ambiguity/);
  assert.match(skill, /A partial search does not establish that something never happened/);
  assert.match(skill, /including recorded tool outputs and your reasoning/);
  assert.match(skill, /including downloaded sources/);
  assert.match(skill, /without re-verifying every fact/);
  assert.match(skill, /not whether an earlier conclusion was correct/);
  assert.match(skill, /session audits, debugging, and cross-session analysis are separate/);

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
module.exports.checkRecoveryTriggers = checkRecoveryTriggers;
module.exports.checkRecoveryChoices = checkRecoveryChoices;
