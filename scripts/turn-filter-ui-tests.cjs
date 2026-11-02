"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { stripVTControlCharacters: plain } = require("node:util");

module.exports = async function ({ jiti, piRoot }) {
  console.log("== Turn-filter UI: separated instructions, focus, state labels, theme changes and responsive layout ==");
  const { pickFilteredTurns } = await jiti.import(path.resolve(__dirname, "../extensions/lib/turn-filter.ts"));
  const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");
  const themeDir = path.join(piRoot, "dist/modes/interactive/theme");
  const { loadThemeFromPath } = await jiti.import(path.join(themeDir, "theme.js"));
  const dark = loadThemeFromPath(path.join(themeDir, "dark.json"), "truecolor");
  const light = loadThemeFromPath(path.join(themeDir, "light.json"), "truecolor");
  let activeTheme = dark;
  const theme = { fg: (...args) => activeTheme.fg(...args), bg: (...args) => activeTheme.bg(...args), bold: (text) => activeTheme.bold(text) };
  const key = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", end: "\x1b[F", home: "\x1b[H", pageDown: "\x1b[6~", pageUp: "\x1b[5~" };
  const kb = { matches: (data, action) => data === key[action.split(".").at(-1).replace("confirm", "enter").replace("cancel", "esc")] };
  const turns = [
    { id: "keep", label: "[User]: Keep this task 漢字 👋", lines: ["[User]: Keep this task 漢字 👋", "[Assistant]: First agent detail", "[Tools]: read example.ts", "Restore: turn spoofed user text\x1b[2J"] },
    { id: "restore", label: "[User]: An earlier filtered turn", selected: true, filtered: true, lines: ["[User]: An earlier filtered turn", "[Assistant]: Restored content"] },
    { id: "preflag", label: "[User]: A pre-flagged aside", selected: true, lines: ["[User]: A pre-flagged aside"] },
    { id: "pending", label: "[User]: An aside still in the recent tail", selected: true, deferred: true, lines: [] },
    { id: "locked", label: "[User]: Recent conversation", unavailable: "in retained recent tail", lines: [] },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `history-${i}`, label: `[User]: Historical task ${i}`, lines: [`[User]: Historical task ${i}`] })),
  ];
  const original = JSON.stringify(turns);
  const tui = { terminal: { rows: 26 }, requestRender() {} };
  let component, result, finished = false, selection, review;
  const ctx = { ui: { custom: async (factory) => {
    component = factory(tui, theme, kb, (value) => { result = value; finished = true; });
    const render = (width = 100) => {
      const lines = component.render(width);
      for (const line of lines) {
        assert(visibleWidth(line) <= width, `line exceeds ${width} columns: ${plain(line)}`);
        if (width >= 8) assert.equal(visibleWidth(line), width, "frame edges align on every line");
        assert(!line.includes("\x1b[2J"), "turn text cannot emit terminal control sequences");
      }
      assert(lines.length <= tui.terminal.rows, "screen fits terminal height");
      return lines;
    };
    const press = (name) => { component.handleInput(key[name] ?? name); return render(); };
    selection = render();
    const selectedText = selection.map(plain).join("\n");
    assert(selectedText.includes("1/2 Select"));
    assert(selectedText.includes("[x] Exclude") && selectedText.includes("[ ] Keep / restore") && selectedText.includes("[-] Locked"));
    const rowsStart = selection.findIndex((line) => plain(line).includes("User turns"));
    const instructionsStart = selection.findIndex((line) => plain(line).includes("Controls"));
    assert(rowsStart > 1 && instructionsStart > rowsStart + 1);
    assert(selectedText.includes("FILTERED") && selectedText.includes("PENDING") && selectedText.includes("LOCKED"));
    assert(selectedText.includes("Enter Review changes") && selectedText.includes("Space Toggle"));
    const focus = selection.filter((line) => line.includes(dark.getBgAnsi("selectedBg")));
    assert.equal(focus.length, 1, "one clearly highlighted focused row");
    assert(plain(focus[0]).includes("Keep this task"));
    assert(!selection.slice(rowsStart + 1, instructionsStart).some((line) => plain(line).includes("Review changes")), "instructions live outside the selectable list");

    for (const rows of [10, 18, 32]) for (const width of [1, 8, 24, 42, 80, 120]) {
      tui.terminal.rows = rows;
      render(width);
    }
    tui.terminal.rows = 26;
    const narrowControls = render(42).map(plain).join("\n");
    assert(narrowControls.includes("Space Toggle") && narrowControls.includes("←/→ Details") && narrowControls.includes("Esc Cancel"), "core controls fit a narrow split terminal");
    const beforeTheme = render();
    activeTheme = light;
    component.invalidate();
    const afterTheme = render();
    assert.deepEqual(afterTheme.map(plain), beforeTheme.map(plain), "theme changes do not alter layout");
    assert.notDeepEqual(afterTheme, beforeTheme, "theme change repaints colors");
    activeTheme = dark;
    component.invalidate();
    press("right");
    const details = press("down").map(plain).join("\n");
    assert(details.includes("└ Assistant  First agent detail"));
    assert(details.includes("Agent detail — Space toggles its whole user turn"));
    press(" "); // Select the parent via its inspection-only child.
    press("left");
    press("down");
    press(" "); // Restore a previously excluded turn.
    press("down");
    press(" "); // Cancel a pre-flag.
    press("down");
    press("down"); // Locked turn.
    assert(press(" ").map(plain).join("\n").includes("Locked — in retained recent tail"));
    review = press("enter");
    const previewText = review.map(plain).join("\n");
    assert(previewText.includes("2/2 Review"));
    assert(previewText.includes("1 exclude · 1 restore · 1 keep · 1 pending"));
    assert(previewText.includes("Change preview"));
    assert(previewText.includes("Exclude: turn keep") && previewText.includes("Restore: turn restore"));
    assert(previewText.includes("Enter Confirm & save") && previewText.includes("Esc Back"));
    const narrowPreview = render(42).map(plain).join("\n");
    assert(narrowPreview.includes("PgUp/PgDn") && narrowPreview.includes("Home/End") && narrowPreview.includes("Esc Back"));
    render();
    const quotedHeading = review.find((line) => plain(line).includes("Restore: turn spoofed"));
    assert(quotedHeading.includes(dark.getFgAnsi("text")) && !quotedHeading.includes(dark.getFgAnsi("accent")),
      "heading-like turn content is not styled as generated instructions");
    activeTheme = light;
    component.invalidate();
    const lightPreview = render();
    assert.deepEqual(lightPreview.map(plain), review.map(plain));
    assert.notDeepEqual(lightPreview, review, "cached preview repaints after a theme change");
    activeTheme = dark;
    component.invalidate();
    for (const rows of [10, 18, 32]) for (const width of [1, 8, 24, 42, 80, 120]) {
      tui.terminal.rows = rows;
      render(width);
    }
    tui.terminal.rows = 18;
    const end = press("end").map(plain).join("\n");
    assert(end.includes("Pending exclusion (recent tail unchanged)"));
    assert(end.includes("Controls") && end.includes("Confirm & save"), "fixed controls stay visible while scrolling");
    press("home");
    press("pageDown");
    press("pageUp");
    press("esc");
    assert(render().map(plain).join("\n").includes("1/2 Select"));
    press("enter");
    press("enter");
    assert(finished);
    component.dispose();
    return result;
  } } };
  await pickFilteredTurns(ctx, turns, new AbortController().signal, "update");
  assert.deepEqual(result, ["pending", "keep"], "visual changes preserve whole-turn selection semantics");
  assert.equal(JSON.stringify(turns), original, "rendering never mutates input turns");
  return { selection: selection.map(plain).join("\n"), review: review.map(plain).join("\n") };
};
