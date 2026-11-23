"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function configTests(h) {
  const { jiti, factory, load, SessionManager, root, makeContext, user, assistant, text, toolText, capControl } = h;
  const { resolveConfig } = await jiti.import(path.join(__dirname, "../extensions/lib/config.ts"));
  const { SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
  const keys = ["MECH_COMPACT_MAX_SUMMARY_PERCENT", "MECH_COMPACT_MAX_SUMMARY_CHARS", "MECH_COMPACT_LOOKUP_MODEL",
    "MECH_COMPACT_LOOKUP_TURNS", "MECH_COMPACT_LOOKUP_MAX_CALLS", "MECH_COMPACT_MAIN_AGENT_LOOKUP", "MECH_COMPACT_LOOKUP_SESSION_FILE"];
  const saved = keys.map((key) => process.env[key]);
  keys.forEach((key) => delete process.env[key]);
  const resolve = (config, env = {}) => resolveConfig({ transparentCompact: config }, env);
  try {
    console.log("== Configuration: defaults, validation, and all six environment overrides ==");
    const defaults = { defaultCapBudget: { unit: "percent", value: 25 }, lookupTurns: 25, lookupMaxCalls: 3,
      lookupModel: undefined, mainAgentLookup: false };
    assert.deepEqual(resolve({}), defaults);
    for (const invalid of [undefined, null, false, 42, "bad", []]) {
      assert.deepEqual(resolveConfig(invalid, {}), defaults);
      assert.deepEqual(resolve(invalid), defaults);
    }
    const settings = { maxSummaryPercent: 12.5, lookupTurns: 4, lookupMaxCalls: 0,
      lookupModel: " provider/model/id ", mainAgentLookup: true };
    assert.deepEqual(resolve(settings), { defaultCapBudget: { unit: "percent", value: 12.5 }, lookupTurns: 4,
      lookupMaxCalls: 0, lookupModel: "provider/model/id", mainAgentLookup: true });
    assert.deepEqual(resolve({ ...settings, maxSummaryChars: 6000 }).defaultCapBudget, { unit: "chars", value: 6000 });
    assert.equal(resolve({ maxSummaryPercent: 100 }).defaultCapBudget.value, 100);
    assert.equal(resolve({ lookupMaxCalls: 1 }).lookupMaxCalls, 1);
    for (const invalid of [null, false, true, "10", 0, -1, 100.1, NaN, Infinity]) {
      assert.deepEqual(resolve({ maxSummaryPercent: invalid }).defaultCapBudget, defaults.defaultCapBudget);
    }
    for (const invalid of [null, false, true, "10", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(resolve({ maxSummaryChars: invalid }).defaultCapBudget, defaults.defaultCapBudget);
      assert.equal(resolve({ lookupTurns: invalid }).lookupTurns, defaults.lookupTurns);
    }
    for (const invalid of [null, false, true, "0", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(resolve({ lookupMaxCalls: invalid }).lookupMaxCalls, defaults.lookupMaxCalls);
    }
    for (const invalid of [null, false, true, 42, {}, "", "   "]) {
      assert.equal(resolve({ lookupModel: invalid }).lookupModel, undefined);
    }
    for (const invalid of [null, "true", 1, {}, []]) {
      assert.equal(resolve({ mainAgentLookup: invalid }).mainAgentLookup, false);
    }
    const overrides = { MECH_COMPACT_MAX_SUMMARY_PERCENT: " 30 ", MECH_COMPACT_LOOKUP_TURNS: "7",
      MECH_COMPACT_LOOKUP_MAX_CALLS: "2", MECH_COMPACT_LOOKUP_MODEL: " override/model ", MECH_COMPACT_MAIN_AGENT_LOOKUP: "0" };
    assert.deepEqual(resolve(settings, overrides), { defaultCapBudget: { unit: "percent", value: 30 }, lookupTurns: 7,
      lookupMaxCalls: 2, lookupModel: "override/model", mainAgentLookup: false });
    assert.deepEqual(resolve({ maxSummaryChars: 6000 }, { ...overrides, MECH_COMPACT_MAX_SUMMARY_CHARS: "9000" }).defaultCapBudget,
      { unit: "chars", value: 9000 });
    assert.deepEqual(resolve({ maxSummaryChars: 6000 }, overrides).defaultCapBudget,
      { unit: "chars", value: 6000 }, "character caps win after resolving each key's precedence");
    assert.equal(resolve({ lookupMaxCalls: 2 }, { MECH_COMPACT_LOOKUP_MAX_CALLS: "0" }).lookupMaxCalls, 0);
    assert.equal(resolve({ mainAgentLookup: false }, { MECH_COMPACT_MAIN_AGENT_LOOKUP: "1" }).mainAgentLookup, true);
    for (const invalid of ["", "   ", "garbage", "Infinity", "-1", "9007199254740992"]) {
      const env = Object.fromEntries(keys.map((key) => [key, invalid]));
      // Arbitrary nonempty model identifiers are resolved by Pi at lookup time.
      delete env.MECH_COMPACT_LOOKUP_MODEL;
      assert.deepEqual(resolve(settings, env), resolve(settings), `invalid overrides fall through: ${JSON.stringify(invalid)}`);
    }
    assert.deepEqual(resolve(settings, { MECH_COMPACT_LOOKUP_TURNS: "2oops", MECH_COMPACT_LOOKUP_MAX_CALLS: "1.5",
      MECH_COMPACT_MAX_SUMMARY_CHARS: "0", MECH_COMPACT_MAX_SUMMARY_PERCENT: "101", MECH_COMPACT_LOOKUP_MODEL: " " }), resolve(settings));
    assert.deepEqual(resolve({ lookupSessionFile: "/ignored/file.jsonl" }), defaults, "history source stays environment-only");

    console.log("== Pi file settings: trusted project merge, independent instances, and reload ==");
    const cwd = path.join(root, "config-project"), agentDir = path.join(root, "config-agent");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ transparentCompact: settings }));
    const projectFile = path.join(cwd, ".pi/settings.json");
    fs.writeFileSync(projectFile, JSON.stringify({ transparentCompact: { maxSummaryPercent: 10, lookupTurns: 2 } }));
    const untrusted = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getSettings();
    const trusted = SettingsManager.create(cwd, agentDir, { projectTrusted: true }).getSettings();
    assert.deepEqual(resolveConfig(untrusted), resolve(settings));
    assert.deepEqual(resolveConfig(trusted), resolve({ ...settings, maxSummaryPercent: 10, lookupTurns: 2 }));
    const make = (config) => {
      const manager = SessionManager.inMemory(cwd);
      const u = manager.appendMessage(user("CONFIG_CAP_CONTENT ".repeat(5000)));
      const kept = manager.appendMessage(user("Retained tail"));
      const ref = { current: manager, settings: config };
      const ext = load(factory, ref);
      const notices = [];
      const ctx = { ...makeContext(manager, cwd), model: { provider: "session", id: "model", contextWindow: 10000 },
        ui: { notify: (message) => notices.push(message) } };
      const status = async () => {
        await capControl(ext, () => ref.settings).handler("", ctx);
        return notices.at(-1);
      };
      return { manager, u, kept, ref, ext, ctx, status };
    };
    const global = make(untrusted), project = make(trusted);
    assert((await global.status()).includes("budget 12.5%"));
    assert((await project.status()).includes("budget 10%"));
    assert((await global.status()).includes("budget 12.5%"), "another instance must not overwrite global configuration");
    fs.writeFileSync(projectFile, JSON.stringify({ transparentCompact: { maxSummaryChars: 3000 } }));
    project.ref.settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true }).getSettings();
    // A replacement extension instance reads the new effective settings, not an import-time cache.
    const reloaded = load(factory, project.ref);
    await capControl(reloaded, () => project.ref.settings).handler("", project.ctx);
    assert((await project.status()).includes("budget 3000c"));
    assert.equal(project.manager.getEntries().filter((e) => e.type === "custom").length, 0, "reading defaults does not persist them");

    console.log("== Configured caps affect compaction; recorded session choices override files and environment ==");
    const attempt = (f) => f.ext.handlers.session_before_compact({ branchEntries: f.manager.getBranch(), reason: "manual",
      preparation: { messagesToSummarize: [f.manager.getEntry(f.u).message], turnPrefixMessages: [],
        firstKeptEntryId: f.kept, tokensBefore: 10000 }, signal: new AbortController().signal }, f.ctx);
    for (const f of [global, project]) {
      const result = await attempt(f);
      assert(result.compaction);
      assert(result.compaction.summary.length < 8000);
      assert(!result.compaction.summary.includes(f.manager.getEntry(f.u).message.content));
      assert(result.compaction.details.span.lines[0].includes(f.manager.getEntry(f.u).message.content), "cap preserves the raw span");
    }
    process.env.MECH_COMPACT_MAX_SUMMARY_CHARS = "5000";
    assert((await project.status()).includes("budget 5000c"));
    await capControl(project.ext, () => project.ref.settings).handler("off 6000c", project.ctx);
    project.ref.settings = { transparentCompact: { maxSummaryChars: 1000 } };
    process.env.MECH_COMPACT_MAX_SUMMARY_CHARS = "2000";
    assert((await project.status()).includes("cap: off; budget 6000c"));
    assert((await attempt(project)).compaction.summary.includes(project.manager.getEntry(project.u).message.content));
    const resumedExt = load(factory, project.ref);
    await resumedExt.handlers.session_start({ reason: "reload" }, project.ctx);
    await capControl(resumedExt, () => project.ref.settings).handler("", project.ctx);
    assert((await project.status()).includes("cap: off; budget 6000c"));
    project.manager.branch(project.kept);
    assert((await project.status()).includes("cap: warn; budget 2000c"), "navigating before the choice restores configured defaults");
    delete process.env.MECH_COMPACT_MAX_SUMMARY_CHARS;

    console.log("== Configured lookup turn and consecutive-call limits drive the dispatcher ==");
    const lookup = make({ transparentCompact: { lookupTurns: 4, lookupMaxCalls: 1 } });
    await require("./lookup-budget-tests.cjs")({ ...h, ext: lookup.ext, expected: 4 });
    process.env.MECH_COMPACT_LOOKUP_TURNS = "2";
    await require("./lookup-budget-tests.cjs")({ ...h, ext: lookup.ext, expected: 2 });
    delete process.env.MECH_COMPACT_LOOKUP_TURNS;
    await require("./lookup-tests.cjs").limitTests({ ...h, ext: lookup.ext, expected: 1 });
    const unlimited = make({ transparentCompact: { lookupMaxCalls: 0 } });
    await require("./lookup-tests.cjs").limitTests({ ...h, ext: unlimited.ext, expected: 0 });
    process.env.MECH_COMPACT_LOOKUP_MAX_CALLS = "2";
    await require("./lookup-tests.cjs").limitTests({ ...h, ext: unlimited.ext, expected: 2 });
    delete process.env.MECH_COMPACT_LOOKUP_MAX_CALLS;

    console.log("== Configured lookup model selection, override, and unresolved-model fallback ==");
    const selectedModel = { provider: "configured", id: "model/id" };
    const modelRun = make({ transparentCompact: { lookupModel: "configured/model/id" } });
    let selected;
    const ctx = { ...modelRun.ctx, modelRegistry: {
      find: (provider, id) => provider === selectedModel.provider && id === selectedModel.id ? selectedModel : undefined,
      complete: async (model) => { selected = model; return assistant([text("Found evidence.")]); },
    } };
    const invoke = async () => {
      const result = await modelRun.ext.tools.context_lookup.execute("config-model", { question: "Earlier evidence?" }, undefined, undefined, ctx);
      assert.equal(toolText(result), "Found evidence.");
      return selected;
    };
    assert.equal(await invoke(), selectedModel);
    process.env.MECH_COMPACT_LOOKUP_MODEL = "missing/model";
    assert.equal(await invoke(), ctx.model, "unresolved environment model falls back to the session model");
    process.env.MECH_COMPACT_LOOKUP_MODEL = " ";
    assert.equal(await invoke(), selectedModel, "empty override leaves the configured model intact");
    delete process.env.MECH_COMPACT_LOOKUP_MODEL;
    modelRun.ref.settings = { transparentCompact: { lookupModel: "missing/model" } };
    assert.equal(await invoke(), ctx.model, "unresolved configured model falls back to the session model");
    process.env.MECH_COMPACT_LOOKUP_MODEL = "configured/model/id";
    assert.equal(await invoke(), selectedModel, "environment overrides the configured model");
    delete process.env.MECH_COMPACT_LOOKUP_MODEL;
    modelRun.ref.settings = { transparentCompact: { lookupModel: "malformed" } };
    assert.equal(await invoke(), ctx.model);
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
};
