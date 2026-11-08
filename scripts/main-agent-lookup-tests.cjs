"use strict";
// Offline integration tests: real Pi loadouts, prompts, persistence and tools.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { piRoot, jitiAliases } = require("./pi-runtime.cjs");
const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
const jiti = createJiti(__filename, { alias: jitiAliases });
const { assistant, text, call } = require("./reorientation-fixture.cjs");
const root = path.resolve(__dirname, "..");
const modeEntry = "transparent-compact:main-agent-lookup";
const directNames = ["context_list_entries", "context_search", "context_show_entry"];
const epoch = Date.parse("2026-01-01T00:00:00Z");
const user = (content) => ({ role: "user", content, timestamp: epoch });
const toolText = (result) => result.content.map((b) => b.text ?? "").join("");

async function main() {
  const { SessionManager, SettingsManager, createAgentSession, ModelRuntime, loadSkillsFromDir } = await jiti.import("@earendil-works/pi-coding-agent");
  const { AssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt } = await jiti.import("@earendil-works/pi-ai");
  const { loadExtensions } = await import(pathToFileURL(path.join(piRoot, "dist/core/extensions/loader.js")).href);
  const { recoveryText } = await jiti.import(path.join(root, "extensions/lib/main-agent-lookup.ts"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "main-agent-lookup-"));
  const envKeys = ["MECH_COMPACT_MAIN_AGENT_LOOKUP", "MECH_COMPACT_LOOKUP_SESSION_FILE", "MECH_COMPACT_MAX_SUMMARY_CHARS"];
  const saved = envKeys.map((key) => process.env[key]);
  envKeys.forEach((key) => delete process.env[key]);
  const model = { id: "stub-model", provider: "stub", api: "test", name: "Test model", baseUrl: "http://127.0.0.1:1/never",
    reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const skills = loadSkillsFromDir({ dir: path.join(root, "skills/context-retrieval"), source: "test" });
  assert.deepEqual(skills.diagnostics, []);

  async function boot(manager, settings = {}, scripted = [assistant([text("Done.")])]) {
    const loaded = await loadExtensions([path.join(root, "extensions/index.ts")], cwd);
    assert.deepEqual(loaded.errors, []);
    const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.hasConfiguredAuth = () => true;
    runtime.getAuth = async () => ({ auth: { apiKey: "offline-test" } });
    let nestedCalls = 0;
    runtime.complete = async () => { nestedCalls++; throw new Error("Direct recovery must not call a model"); };
    const requests = [], notices = [];
    let turn = 0;
    runtime.streamSimple = (_model, context) => {
      requests.push(structuredClone(context));
      const message = scripted[turn++] ?? assistant([text("Done.")]);
      const stream = new AssistantMessageEventStream();
      if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
      return stream;
    };
    const loader = {
      getExtensions: () => loaded,
      getSkills: () => structuredClone(skills),
      getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
    };
    const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, model,
      resourceLoader: loader, sessionManager: manager, thinkingLevel: "off",
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 200 },
        retry: { enabled: false }, cacheWarming: "off", ...settings }),
    });
    await session.bindExtensions({ mode: "json", uiContext: { notify: (message) => notices.push(message) },
      onError: (error) => { throw new Error(JSON.stringify(error)); } });
    return { session, loaded, requests, notices, nestedCalls: () => nestedCalls };
  }
  const optIn = { transparentCompact: { mainAgentLookup: true } };
  const recoveryNames = (run) => run.session.getActiveToolNames().filter((name) => name.startsWith("context_"));
  const assertDirect = (run) => {
    assert.deepEqual(recoveryNames(run), directNames);
    assert.equal(run.session.getAllTools().find((t) => t.name === "context_lookup").exposure, "hidden");
  };
  const invoke = async (run, manager, name, args, signal) => {
    const definition = run.loaded.extensions[0].tools.get(name).definition;
    return definition.execute("test", args, signal, undefined, { cwd, sessionManager: manager });
  };
  function seed(manager) {
    const original = manager.appendMessage(user("Keep historical literal context_lookup and context_show_entry unchanged."));
    const a = manager.appendMessage(assistant([
      { type: "thinking", thinking: "OLD_REASONING exact-choice" },
      text("Historical assistant prose context_lookup."), call("read", { path: "old.txt" }, "old-read"),
    ], "toolUse"));
    const t = manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "old-read",
      content: [text("EVIDENCE_BEGIN\n" + "long historical output\n".repeat(2000) + "EVIDENCE_END")], isError: false, timestamp: epoch });
    manager.appendCustomMessageEntry("custom", "Hidden custom content", false);
    manager.appendMessage(user("Continue. " + "retained context ".repeat(200)));
    return { original, a, t };
  }
  try {
    console.log("== Direct recovery: exclusive real-Pi loadout, skill selection, and explicit opt-in ==");
    const normalManager = SessionManager.inMemory(cwd);
    const normal = await boot(normalManager);
    try {
      assert.deepEqual(recoveryNames(normal), ["context_lookup"]);
      assert(!normalManager.getEntries().some((e) => e.type === "custom" || e.type === "custom_message" || e.type === "message"), "default startup writes no extension state or messages");
      await normal.session.prompt("Ordinary work.");
      assert.deepEqual(getCurrentTools(normal.requests[0].messages).filter((t) => t.name.startsWith("context_")).map((t) => t.name), ["context_lookup"]);
      const prompt = getCurrentSystemPrompt(normal.requests[0].messages);
      assert(prompt.includes(skills.skills[0].description));
      assert(prompt.includes(skills.skills[0].filePath));
      assert(!/main-agent-retrieval|context_search|mainAgentLookup/.test(prompt));
      assert(!normalManager.getEntries().some((e) => e.customType === modeEntry));
      assert.deepEqual(normal.notices, [], "no default-mode selection or startup notices");
      assert.equal(recoveryText(normalManager.getBranch(), "use `context_lookup`"), "use `context_lookup`");
    } finally { normal.session.dispose(); }

    // File settings use Pi's trusted, merged configuration rather than a second config parser.
    const configDir = path.join(cwd, "config");
    fs.mkdirSync(path.join(configDir, ".pi"), { recursive: true });
    const agentDir = path.join(cwd, "agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(optIn));
    fs.writeFileSync(path.join(configDir, ".pi/settings.json"), JSON.stringify({ transparentCompact: { mainAgentLookup: false } }));
    assert.equal(SettingsManager.create(configDir, agentDir, { projectTrusted: false }).getSettings().transparentCompact.mainAgentLookup, true);
    assert.equal(SettingsManager.create(configDir, agentDir, { projectTrusted: true }).getSettings().transparentCompact.mainAgentLookup, false);

    let manager = SessionManager.inMemory(cwd);
    const ids = seed(manager);
    const run = await boot(manager, optIn, [
      assistant([call("context_search", { pattern: "EVIDENCE_BEGIN", before: 0, after: 0 }, "direct-search")], "toolUse"),
      assistant([call("context_show_entry", { id: ids.t }, "direct-show")], "toolUse"), assistant([text("Recovered.")]),
    ]);
    try {
      assertDirect(run);
      assert.equal(manager.getEntries().filter((e) => e.customType === modeEntry).length, 1);
      await run.session.prompt("Recover the earlier output.");
      for (const request of run.requests) {
        assert.deepEqual(getCurrentTools(request.messages).filter((t) => t.name.startsWith("context_")).map((t) => t.name), directNames);
        const prompt = getCurrentSystemPrompt(request.messages);
        assert(prompt.includes("main-agent-retrieval.md"));
        assert(!prompt.includes(skills.skills[0].description));
        assert(!prompt.includes(skills.skills[0].filePath));
      }
      assert.equal(run.nestedCalls(), 0);
      const results = manager.getBranch().filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName.startsWith("context_"));
      assert.equal(results.length, 2);
      assert(toolText(results[0].message).includes(ids.t));
      assert(toolText(results[1].message).includes("EVIDENCE_BEGIN"));

      let page = toolText(await invoke(run, manager, "context_show_entry", { id: ids.t }));
      let all = page, pages = 1;
      while (!page.includes("EVIDENCE_END")) {
        const offset = /Continue with the same parameters and offset=(\d+)/.exec(page)?.[1];
        assert(offset, "a bounded result supplies a usable continuation");
        page = toolText(await invoke(run, manager, "context_show_entry", { id: ids.t, offset: Number(offset) }));
        all += page; pages++;
        assert(pages < 20);
      }
      assert(pages > 1 && all.includes("EVIDENCE_END"));
      const related = toolText(await invoke(run, manager, "context_show_entry", { id: ids.a, includeRelated: true }));
      assert(related.includes("OLD_REASONING exact-choice"));
      assert(related.includes("EVIDENCE_BEGIN"));
      assert((await invoke(run, manager, "context_search", { pattern: "x", throughEntry: "missing" })).isError);
      const aborted = new AbortController(); aborted.abort();
      assert((await invoke(run, manager, "context_show_entry", { id: ids.t }, aborted.signal)).isError);

      await run.session.compact();
      const compaction = manager.getBranch().findLast((e) => e.type === "compaction");
      assert(compaction.summary.includes("context_search"));
      assert(compaction.summary.includes("[User]: Keep historical literal context_lookup and context_show_entry unchanged."));
      assert(compaction.summary.includes("[Assistant]: Historical assistant prose context_lookup."));
      assert(!compaction.summary.includes("a subagent searches"));
      assert(!compaction.summary.includes("use context_lookup]"));
      await run.session.prompt("Continue after compaction.");
      const reminder = manager.getBranch().findLast((e) => e.type === "custom_message" && e.customType === "transparent-compact:reorient");
      assert(reminder && !reminder.content.includes("context_lookup"));
      assert.equal(run.nestedCalls(), 0);
    } finally { run.session.dispose(); }

    console.log("== Mode persistence, inherited forks, tree navigation, and rejected late opt-in ==");
    // Reload/resume from disk, without configuration, retains the recorded choice.
    const sessionFile = path.join(cwd, "saved-session.jsonl");
    fs.writeFileSync(sessionFile, [manager.getHeader(), ...manager.getEntries()].map((e) => JSON.stringify(e)).join("\n") + "\n");
    manager = SessionManager.open(sessionFile, cwd);
    const resumed = await boot(manager);
    try {
      assertDirect(resumed);
      await resumed.session.prompt("Continue resumed session.");
      assert(getCurrentSystemPrompt(resumed.requests[0].messages).includes("main-agent-retrieval.md"));
      await resumed.session.navigateTree(ids.original, { summarize: false });
      assertDirect(resumed);
      assert(manager.getBranch().some((e) => e.customType === modeEntry));
      await resumed.session.prompt("Continue the earlier branch.");
      assert(getCurrentSystemPrompt(resumed.requests.at(-1).messages).includes("main-agent-retrieval.md"));
    } finally { resumed.session.dispose(); }
    const forkFile = manager.createBranchedSession(manager.getLeafId());
    assert(forkFile);
    const forkRun = await boot(SessionManager.open(forkFile, cwd));
    try { assertDirect(forkRun); } finally { forkRun.session.dispose(); }

    // A compaction on an abandoned branch also makes this existing session ineligible.
    for (const mechanical of [false, true]) {
      const old = SessionManager.inMemory(cwd);
      const first = old.appendMessage(user("Earlier task"));
      old.appendCompaction("Existing checkpoint", first, 1000, mechanical ? { kind: "mech-compact", span: { lines: [] } } : undefined);
      old.branch(first);
      const late = await boot(old, optIn);
      try {
        assert.deepEqual(recoveryNames(late), ["context_lookup"]);
        assert(late.notices.some((notice) => notice.includes("already has compactions")));
        assert(!old.getEntries().some((e) => e.customType === modeEntry));
        await late.session.prompt("Continue without changing recovery.");
        assert(getCurrentSystemPrompt(late.requests[0].messages).includes(skills.skills[0].description));
      } finally { late.session.dispose(); }
    }

    process.env.MECH_COMPACT_MAIN_AGENT_LOOKUP = "1";
    const envRun = await boot(SessionManager.inMemory(cwd));
    try { assertDirect(envRun); } finally { envRun.session.dispose(); }
    process.env.MECH_COMPACT_MAIN_AGENT_LOOKUP = "0";
    const envOff = await boot(SessionManager.inMemory(cwd), optIn);
    try { assert.deepEqual(recoveryNames(envOff), ["context_lookup"]); } finally { envOff.session.dispose(); }
    delete process.env.MECH_COMPACT_MAIN_AGENT_LOOKUP;

    console.log("== Direct pagination excludes newly appended entries; source errors fail closed ==");
    const paging = SessionManager.inMemory(cwd);
    for (let i = 0; i < 220; i++) paging.appendMessage(user(`row-${i} ${"preview ".repeat(20)}`));
    const pagingRun = await boot(paging, optIn);
    try {
      let page = toolText(await invoke(pagingRun, paging, "context_list_entries", {}));
      assert(page.includes("Page limited"));
      paging.appendMessage(user("NEW_APPEND_SENTINEL"));
      let pages = 1, listing = page;
      while (page.includes("Page limited")) {
        const offset = Number(/Continue with the same parameters and offset=(\d+)/.exec(page)[1]);
        const throughEntry = JSON.parse(/throughEntry=("[^"]+")/.exec(page)[1]);
        page = toolText(await invoke(pagingRun, paging, "context_list_entries", { offset, throughEntry }));
        listing += page;
        assert(++pages < 10);
      }
      assert(!listing.includes("NEW_APPEND_SENTINEL"));
      assert(listing.includes("row-219"));
      process.env.MECH_COMPACT_LOOKUP_SESSION_FILE = "relative-source.jsonl";
      const invalid = await invoke(pagingRun, paging, "context_search", { pattern: "row" });
      assert(invalid.isError && toolText(invalid).includes("absolute path"));
      assert(!fs.existsSync(path.join(cwd, "relative-source.jsonl")));
      delete process.env.MECH_COMPACT_LOOKUP_SESSION_FILE;
    } finally { pagingRun.session.dispose(); }

    console.log("== Automatic and overflow continuations retain direct tools and reminders ==");
    for (const reason of ["threshold", "overflow"]) {
      const automatic = SessionManager.inMemory(cwd);
      seed(automatic);
      const first = reason === "threshold"
        ? assistant([call("context_search", { pattern: "OLD_REASONING", before: 0, after: 0 }, "threshold-search")], "toolUse")
        : { ...assistant([], "error"), errorMessage: "maximum context length exceeded" };
      first.usage = { ...first.usage, input: 90000, totalTokens: 90000 };
      const automaticRun = await boot(automatic, { ...optIn, compaction: { enabled: true, keepRecentTokens: 200 } },
        [first, assistant([text("Continued after compaction.")])]);
      try {
        await automaticRun.session.prompt("Recover earlier evidence.");
        const compacted = automatic.getBranch().findLast((e) => e.type === "compaction");
        assert(compacted, reason);
        assert.equal(compacted.details.span.reason, reason);
        assertDirect(automaticRun);
        for (const request of automaticRun.requests) {
          assert.deepEqual(getCurrentTools(request.messages).filter((t) => t.name.startsWith("context_")).map((t) => t.name), directNames);
          assert(getCurrentSystemPrompt(request.messages).includes("main-agent-retrieval.md"));
        }
        const reminder = automatic.getBranch().findLast((e) => e.type === "custom_message" && e.customType === "transparent-compact:reorient");
        assert(reminder && !reminder.content.includes("context_lookup"));
        assert.equal(automaticRun.nestedCalls(), 0);
      } finally { automaticRun.session.dispose(); }
    }

    // A truncation suffix is generated text; its retained user prefix is not.
    const { capSpans } = await jiti.import(path.join(root, "extensions/lib/checkpoint-cap.ts"));
    const capped = capSpans([{ lines: ["[User]: literal context_lookup " + "x".repeat(2000)] }], 500,
      () => 0, (value) => recoveryText(manager.getBranch(), value));
    assert(capped.lines[0][0].includes("literal context_lookup"));
    assert(!capped.lines[0][0].includes("use context_lookup]"));

    console.log("== Explicit retrieval skill command uses direct instructions only ==");
    const skillRun = await boot(SessionManager.inMemory(cwd), optIn);
    try {
      await skillRun.session.prompt("/skill:context-retrieval Recover the earlier error.");
      const userMessages = skillRun.requests[0].messages.filter((m) => m.role === "user");
      assert(JSON.stringify(userMessages).includes("context_search"));
      assert(!JSON.stringify(userMessages).includes("a subagent searches"));
      assert(!JSON.stringify(userMessages).includes("only supply"));
    } finally { skillRun.session.dispose(); }
    console.log("MAIN-AGENT LOOKUP TESTS PASSED — no live model calls");
  } finally {
    envKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
