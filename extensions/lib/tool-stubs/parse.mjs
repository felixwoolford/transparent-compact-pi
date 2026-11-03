import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

let runtime;
async function loadParser() {
  const [wasm, support] = await Promise.all([
    readFile(new URL('./parser/shell.wasm', import.meta.url)),
    readFile(new URL('./parser/wasm_exec.js', import.meta.url), 'utf8'),
  ]);
  let register;
  const ready = new Promise(resolve => { register = resolve; });
  // Go's unmodified support script installs globals. Keep them local to this
  // runtime so extension reloads do not change Pi's globals or other extensions.
  const scope = vm.createContext({ TextEncoder, TextDecoder, WebAssembly,
    crypto: webcrypto, performance, console, setTimeout, clearTimeout,
    registerShellParser: register });
  vm.runInContext(support, scope, { filename: 'wasm_exec.js' });
  const go = new scope.Go();
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
  // run remains pending while registered JS callbacks are available. Race it
  // against registration so an initialization failure cannot leave us waiting.
  const exited = go.run(instance).then(() => { throw new Error('shell parser runtime exited'); });
  const parse = await Promise.race([ready, exited]);
  return { parse, go }; // Keep the instance alive for later callbacks.
}

/** mvdan/sh's official typed JSON, without schema conversion or shell execution.
 * Input bounds are checked before starting WASM. No binary on PATH, downloads,
 * target-file access, or subprocesses are involved at runtime.
 */
export async function parseShell(command, { maxBytes = 262144 } = {}) {
  if (typeof command !== 'string') throw new TypeError('shell input must be a string');
  if (Buffer.byteLength(command, 'utf8') > maxBytes) throw new Error('shell input byte budget exceeded');
  const { parse } = await (runtime ??= loadParser());
  const result = parse(command);
  if (result.error) throw new SyntaxError(result.error);
  return JSON.parse(result.json);
}
