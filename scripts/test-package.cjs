"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { piRoot } = require("./pi-runtime.cjs");
const root = path.resolve(__dirname, "..");

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.notEqual(manifest.private, true, "public npm package must remain publishable");
  assert.equal(manifest.license, "MIT");
  assert(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
  assert.deepEqual(manifest.pi.skills, ["./skills/context-retrieval"]);
  assert.deepEqual(manifest.dependencies ?? {}, {}, 'parser is bundled directly; there are no npm runtime dependencies');
  for (const host of Object.keys(manifest.peerDependencies)) assert(!(manifest.dependencies ?? {})[host], 'host runtime packages stay peer dependencies');

  const packResult = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    shell: process.platform === "win32",
  }));
  // npm 12 keys results by package name; earlier versions return an array.
  const [packed] = Array.isArray(packResult) ? packResult : Object.values(packResult);
  const packedPaths = new Set(packed.files.map((file) => file.path));
  const { checkCurrentRecoveryLanguage } = require("./recovery-guidance-tests.cjs");
  for (const file of packedPaths) {
    if (/\.(?:md|ts)$/i.test(file))
      checkCurrentRecoveryLanguage(fs.readFileSync(path.join(root, file), "utf8"));
  }
  for (const resource of ["extensions/index.ts", "extensions/lib/checkpoint-cap.ts", "skills/context-retrieval/SKILL.md", "CHANGELOG.md"]) {
    assert(packedPaths.has(resource), `npm package includes ${resource}`);
  }

  const { DefaultPackageManager } = await import(pathToFileURL(path.join(piRoot, "dist/core/package-manager.js")).href);
  const { SettingsManager } = await import(pathToFileURL(path.join(piRoot, "dist/core/settings-manager.js")).href);
  const { loadExtensions } = await import(pathToFileURL(path.join(piRoot, "dist/core/extensions/loader.js")).href);
  const { loadSkills } = await import(pathToFileURL(path.join(piRoot, "dist/core/skills.js")).href);
  const { InteractiveMode } = await import(pathToFileURL(path.join(piRoot, "dist/modes/interactive/interactive-mode.js")).href);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "transparent-compact-package-"));
  try {
    const settingsManager = SettingsManager.inMemory();
    const manager = new DefaultPackageManager({ cwd: root, agentDir: temp, settingsManager });
    const resources = await manager.resolveExtensionSources([root], { temporary: true });
    const extensionPaths = resources.extensions.filter((r) => r.enabled).map((r) => r.path);
    const skillPaths = resources.skills.filter((r) => r.enabled).map((r) => r.path);
    assert.deepEqual(extensionPaths, [path.join(root, "extensions", "index.ts")], "Pi discovers exactly the intended extension");
    // Exercise Pi's real formatter without starting a TUI or model session.
    const display = Object.create(InteractiveMode.prototype);
    assert.equal(display.getCompactExtensionLabel(extensionPaths[0], {
      source: `npm:${manifest.name}`,
      scope: "user",
      baseDir: root,
    }), manifest.name, "npm extension label is just the package name, with no filename suffix");
    assert.deepEqual(skillPaths, [path.join(root, "skills", "context-retrieval", "SKILL.md")], "Pi discovers the bundled skill");
    const loaded = await loadExtensions(extensionPaths, root);
    assert.deepEqual(loaded.errors, [], "real Pi extension loader reports no errors");
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.deepEqual([...extension.tools.keys()], ["context_list_entries", "context_grep", "context_show_entry", "context_lookup"], "session lookup and three direct fallback tools are registered");
    assert.deepEqual([...extension.commands.keys()], ["compaction-method", "cap-compaction", "filter-later", "fl", "filter-auto", "compact-filtered", "filter-turns"], "compaction policy, aside and turn-filtering commands are registered");
    const lookup = extension.tools.get("context_lookup");
    assert.deepEqual(Object.keys(lookup.definition.parameters.properties), ["question"], "lookup accepts only question");
    const skills = loadSkills({ cwd: root, agentDir: temp, skillPaths, includeDefaults: false });
    assert.equal(skills.skills.length, 1);
    assert.equal(skills.skills[0].name, "context-retrieval");
    assert.deepEqual(skills.diagnostics, []);
    assert.deepEqual([...packedPaths].filter((p) => p.startsWith("extensions/")).sort(),
      ['extensions/index.ts', 'extensions/lib/checkpoint-cap.ts',
        'extensions/lib/tool-stubs/display.mjs', 'extensions/lib/tool-stubs/inputs.mjs',
        'extensions/lib/tool-stubs/locations.mjs', 'extensions/lib/tool-stubs/parse.mjs',
        'extensions/lib/tool-stubs/renderer.mjs', 'extensions/lib/tool-stubs/shell.mjs',
        ...['LICENSE.Go', 'LICENSE.mvdan-sh', 'NOTICE.md', 'PATENTS.Go', 'build.json', 'go.mod', 'go.sum', 'main.go', 'shell.wasm', 'wasm_exec.js']
          .map(file => `extensions/lib/tool-stubs/parser/${file}`),
        'extensions/lib/turn-context.ts', 'extensions/lib/turn-filter.ts'].sort(), 'package ships the live renderer, parser, source, and licenses');
    assert.deepEqual([...packedPaths].filter(p => /^(?:source|experiments|scripts|stub-overhaul|node_modules)\//.test(p) || p === 'test.cjs'), [],
      'package excludes development harnesses, tests, dependencies, and obsolete source');

    // Materialize exactly the npm file list: no node_modules, separate parser
    // package, Go toolchain, or development tooling. Exercise the real Pi
    // loader AND an actual AST compaction from that isolated package root.
    const isolated = path.join(temp, 'packed');
    for (const file of packedPaths) {
      const target = path.join(isolated, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target);
    }
    assert(fs.existsSync(path.join(isolated, 'extensions/lib/tool-stubs/parser/shell.wasm')));
    assert(!fs.existsSync(path.join(isolated, 'node_modules')), 'only packed files are needed');
    const isolatedLoad = await loadExtensions([path.join(isolated, 'extensions/index.ts')], isolated);
    assert.deepEqual(isolatedLoad.errors, []);
    const message = (id, value, parentId = null) => ({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00.000Z', message: { timestamp: 0, ...value } });
    const branch = [message('u', { role: 'user', content: 'Inspect files' }),
      message('a', { role: 'assistant', content: [{ type: 'toolCall', id: 'bash', name: 'bash', arguments: {
        command: 'cd src && cat config.json | grep needle; ' + 'cat other/file.txt; '.repeat(15), background: true,
      } }] }, 'u'), message('tail', { role: 'user', content: 'Retained tail' }, 'a'),
      { type: 'custom', id: 'cap', parentId: 'tail', customType: 'transparent-compact:cap-compaction', data: { mode: 'off', budget: { unit: 'chars', value: 80000 } } }];
    const packedHandler = isolatedLoad.extensions[0].handlers.get('session_before_compact')[0];
    const packedResult = await packedHandler({ branchEntries: branch, reason: 'manual', signal: new AbortController().signal,
      preparation: { messagesToSummarize: branch.slice(0, 2).map(entry => entry.message), turnPrefixMessages: [], firstKeptEntryId: 'tail', tokensBefore: 1000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() } } },
      { cwd: '/sandbox', sessionManager: { getBranch: () => branch }, model: { contextWindow: 131072 }, hasUI: false, ui: { notify() {} } });
    assert(packedResult?.compaction?.summary.includes('bash{'), 'packed install can load the bundled upstream parser and generate skeletons');
    assert(packedResult.compaction.details.locations.some(entry => entry.display === 'src/config.json'));
    assert(!packedResult.compaction.summary.includes('background='));
    assert(packedResult.compaction.summary.includes('</locations>'));
    console.log("PACKAGE TEST OK — manifest, packed resources, package-only label, real Pi loader, session lookup, and bundled skill");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("PACKAGE TEST FAILED:", err);
  process.exit(1);
});
