// Build checked-in runtime assets from the pinned upstream module. This is a
// development command, not an npm install hook or a runtime download mechanism.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const dir = path.resolve(__dirname, '../extensions/lib/tool-stubs/parser');
const env = { ...process.env, GOOS: 'js', GOARCH: 'wasm', CGO_ENABLED: '0', GOWORK: 'off', GOFLAGS: '' };
const go = (...args) => execFileSync('go', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const expectedGo = 'go' + fs.readFileSync(path.join(dir, 'go.mod'), 'utf8').match(/^go (\S+)$/m)[1];
const version = go('env', 'GOVERSION');
if (version !== expectedGo) throw new Error(`Use ${expectedGo} to reproduce these assets (got ${version})`);
const dependency = JSON.parse(go('mod', 'download', '-json', 'mvdan.cc/sh/v3'));
go('build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', 'shell.wasm', '.');
fs.chmodSync(path.join(dir, 'shell.wasm'), 0o644);
const goroot = go('env', 'GOROOT');
for (const [source, target] of [
  [path.join(goroot, 'lib/wasm/wasm_exec.js'), 'wasm_exec.js'],
  [path.join(goroot, 'LICENSE'), 'LICENSE.Go'],
  [path.join(goroot, 'PATENTS'), 'PATENTS.Go'],
  [path.join(dependency.Dir, 'LICENSE'), 'LICENSE.mvdan-sh'],
]) {
  const file = path.join(dir, target);
  fs.copyFileSync(source, file);
  fs.chmodSync(file, 0o644); // Module-cache licenses are read-only.
}
const sha256 = file => createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');
const build = { module: dependency.Path, version: dependency.Version, go: version,
  wasmSha256: sha256('shell.wasm'), runtimeSha256: sha256('wasm_exec.js'),
  sourceSha256: Object.fromEntries(['main.go', 'go.mod', 'go.sum'].map(file => [file, sha256(file)])) };
fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify(build, null, 2) + '\n');
console.log(build);
