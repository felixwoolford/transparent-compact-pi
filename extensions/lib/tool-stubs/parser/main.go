// The bridge deliberately uses upstream's AST encoder, not a custom AST schema.
// No interpreter, command execution, filesystem access, or shell expansion.
package main

import (
	"bytes"
	"fmt"
	"strings"
	"syscall/js"

	"mvdan.cc/sh/v3/syntax"
	"mvdan.cc/sh/v3/syntax/typedjson"
)

func parse(_ js.Value, args []js.Value) (result any) {
	// Keep an unexpected upstream panic from terminating the cached WASM runtime.
	defer func() {
		if err := recover(); err != nil {
			result = map[string]any{"error": fmt.Sprint(err)}
		}
	}()
	file, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(strings.NewReader(args[0].String()), "")
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	var out bytes.Buffer
	if err := typedjson.Encode(&out, file); err != nil {
		return map[string]any{"error": err.Error()}
	}
	return map[string]any{"json": out.String()}
}

func main() {
	js.Global().Call("registerShellParser", js.FuncOf(parse))
	select {}
}
