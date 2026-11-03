# Bundled shell parser

`shell.wasm` compiles our `main.go` bridge with the official `mvdan.cc/sh/v3`
parser and `syntax/typedjson` encoder. `go.mod` pins the upstream release;
`go.sum` records its checksums. No interpreter is imported.

- mvdan/sh: BSD 3-Clause; see `LICENSE.mvdan-sh`.
- Go runtime and standard library: see `LICENSE.Go` and `PATENTS.Go`.
- `wasm_exec.js` is copied unmodified from the matching official Go toolchain.
- `build.json` records the upstream/toolchain versions and generated asset hashes.

The bridge and JavaScript loader are part of transparent-compact, under its MIT
license. The bundled assets require no Go installation or runtime downloads.
