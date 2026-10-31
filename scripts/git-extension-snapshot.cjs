"use strict";

// Materialize only the tracked extension source tree at a baseline commit.
// Preserving relative imports keeps optional replay audits usable after modular
// refactors. No checkout, working-tree mutation, or session-file access.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

module.exports = function snapshotExtension(repo, ref, destination) {
  const git = (args, encoding) => execFileSync("git", args, { cwd: repo, ...(encoding ? { encoding } : {}) });
  const commit = git(["rev-parse", ref], "utf8").trim();
  const files = git(["ls-tree", "-r", "--name-only", "-z", commit, "--", "extensions/"], "utf8").split("\0").filter(Boolean);
  for (const file of files) {
    const target = path.resolve(destination, file);
    const relative = path.relative(path.resolve(destination), target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe snapshot path: ${file}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, git(["show", `${commit}:${file}`]));
  }
  const entryPath = path.join(destination, "extensions", "index.ts");
  if (!fs.existsSync(entryPath)) throw new Error(`Baseline ${commit} has no extensions/index.ts`);
  return { commit, entryPath };
};
