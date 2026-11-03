const assert = require('node:assert/strict');
const path = require('node:path');

function locationId(checkpoint, file, cwd) {
  const entry = checkpoint.details.locations.find(entry => entry.kind === 'path' &&
    (entry.display === file || entry.value === file || (cwd && entry.value === path.resolve(cwd, file))));
  assert(entry, `location dictionary defines ${file}`);
  return entry.id;
}
// Test-only decoding of generated IDs for existing retained-evidence assertions.
// The live implementation never discovers references by scanning prose.
function resolvedSummary(checkpoint) {
  const entries = new Map(checkpoint.details.locations.map(entry => [entry.id, entry.display]));
  return checkpoint.summary.replace(/@\d+\b/g, id => entries.get(id) ?? id);
}
module.exports = { locationId, resolvedSummary };
