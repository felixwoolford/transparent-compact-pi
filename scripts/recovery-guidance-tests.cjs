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
  assert(lookup.description.startsWith("Retrieve earlier outputs, findings, decisions, and reasoning hidden by compaction"),
    "lead with compaction-aware recovery, not generic recall");
  assert.match(lookup.description, /unsure what you previously did, observed, or decided/);
  checkRecoveryTriggers(lookup.description);
  for (const example of ["What exact command did I use?", "Did that check actually pass?", "Why did I reject that approach?"])
    assert(lookup.description.includes(example), example);
  assert(lookup.description.includes("Ask a specific historical question"));
  assert.doesNotMatch(lookup.description, /otherwise answer from memory/);
  checkRecoveryChoices(lookup.description);
  assert.doesNotMatch(lookup.description, /before repeating the investigation/i,
    "advertising does not mandate lookup before ordinary investigation");
  assert.match(lookup.description, /subagent searches this conversation's full raw active branch in its own context/);
  assert.match(lookup.description, /If findings are incomplete, use context_list_entries, context_grep, or context_show_entry for the specific detail still missing/);
  assert.match(lookup.description, /returns focused findings rather than the transcript/);
  const scope = "Use the recovery tools for history established by this conversation or its checkpoint, not project discovery, requirements never supplied, other sessions, or abandoned branches.";
  assert(lookup.description.includes(scope));
  assert(lookup.description.indexOf("Did that check actually pass?") < lookup.description.indexOf(scope),
    "recognizable use cases precede restrictions");
  assert.equal(lookup.promptSnippet, "Recover outputs, decisions, reasoning, and provenance hidden by compaction; check earlier details when unsure.");
  assert.match(lookup.parameters.properties.question.description, /earlier details hidden by compaction in this conversation.*ordinary language/);
  assert.match(lookup.parameters.properties.question.description, /output, source of a finding, reason for a decision, or evidence behind notes that conflict with new observations/);
  assert.match(lookup.description, /following their pagination instructions only as needed to answer the question/);
  for (const tool of Object.values(ext.tools)) {
    assert.match(tool.description, /compaction|compacted/, `${tool.name}: description explains compaction recovery`);
    assert.match(tool.promptSnippet, /compaction/, `${tool.name}: snippet explains compaction recovery`);
  }
  assert.match(lookup.parameters.properties.question.description, /ENTRY id from an earlier recovery result/);

  for (const name of ["context_list_entries", "context_grep", "context_show_entry"]) {
    const tool = ext.tools[name];
    assert(tool.description.startsWith(name === "context_show_entry"
      ? "Read a known raw session entry to recover a specific detail hidden by compaction."
      : "Fallback after context_lookup, when its findings are incomplete; same scope as context_lookup."), name);
    assert(!tool.description.includes(scope), `${name}: refer to lookup scope without repeating it`);
    assert(tool.promptSnippet.includes("this conversation"), name);
    assert(tool.description.includes("Continue") && tool.description.includes("only if"), `${name}: paging is conditional`);
    assert(tool.description.includes("Stop once"), `${name}: do not exhaust history by default`);
    assert.doesNotMatch(tool.description, /Follow the reported offset for the rest/);
  }
  assert(ext.tools.context_show_entry.parameters.properties.includeRelated);
  assert.match(ext.tools.context_show_entry.description, /matched tool call\/result entries/);
  assert.match(ext.tools.context_show_entry.description, /ENTRY id returned by context_lookup, context_grep, or context_list_entries/);
  assert.match(ext.tools.context_show_entry.description, /Start with a small maxLines/);
  assert.match(ext.tools.context_show_entry.description, /use it only if the counterpart is needed/);
  assert.match(ext.tools.context_show_entry.description, /do not expand surrounding history by default/);
  assert.match(ext.tools.context_grep.description, /few matches and little surrounding context/);
  assert.match(ext.tools.context_grep.description, /compacted thinking and tool outputs/);
  for (const name of ["context_grep", "context_show_entry"]) {
    assert.match(ext.tools[name].description, /missing, incomplete, or needs more context to resolve ambiguity/);
  }
  assert.match(ext.tools.context_show_entry.description, /a page may not contain the entire entry/);
  assert.match(ext.tools.context_grep.description, /A partial search does not establish that something never happened/);
  assert.match(ext.tools.context_list_entries.description, /not to reread the conversation/);
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
