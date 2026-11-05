import { stripVTControlCharacters } from "node:util";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { episodeCoverage, readMode, selectedEpisode } from "./read-retention.js";
import type { ReadFile, ReadMode, ReadRetention } from "./read-retention.js";

const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** Local draft only. Enter reviews; a second Enter saves. Escape from the
 * preview returns to selection, Escape from selection discards the draft. */
export async function pickRetainedReads(ctx: ExtensionContext, files: ReadFile[], initial: ReadRetention,
  filtered: Set<string>, signal: AbortSignal): Promise<ReadRetention | undefined> {
  return ctx.ui.custom<ReadRetention | undefined>((tui, theme, kb, done) => {
    const state: ReadRetention = { defaults: { ...initial.defaults }, overrides: { ...initial.overrides } };
    let cursor = 0, top = 0, scroll = 0, latestOrder = false;
    let preview: "read" | "review" | undefined;
    let wrapped: { width: number; lines: string[] } | undefined;
    let finished = false;
    const rows = () => latestOrder ? [...files].sort((a, b) => a.episodes.at(-1)!.reads.at(-1)!.order - b.episodes.at(-1)!.reads.at(-1)!.order) : files;
    const pageSize = () => Math.max(1, tui.terminal.rows - 9);
    const episodeOf = (file: ReadFile) => selectedEpisode(file, readMode(state, file.path) === "off" ? "first" : readMode(state, file.path))!;
    const flagged = (file: ReadFile) => episodeOf(file).reads.some((r) => filtered.has(r.owner ?? ""));
    const chars = (file: ReadFile) => episodeOf(file).reads.reduce((n, r) => n + r.text.join("\n").length, 0);
    const heading = (file: ReadFile) => `${readMode(state, file.path).toUpperCase().padEnd(6)} ${file.path} · ${episodeCoverage(episodeOf(file))}` +
      ` · ${chars(file).toLocaleString()} chars${flagged(file) ? " [filtered turn]" : ""}`;
    const contents = (file: ReadFile) => [heading(file), ...episodeOf(file).reads.flatMap((r) => [
      `Entry ${r.entryId} · offset ${r.offset}${r.limit === undefined ? "" : ` · limit ${r.limit}`}${filtered.has(r.owner ?? "") ? " · filtered turn" : ""}`,
      ...r.text.join("\n").split("\n"), "",
    ])];
    const previewLines = () => preview === "read" ? contents(rows()[cursor]) : [
      "Selected outputs (OFF adds no retained copy; normal tail/native content is unchanged):", "",
      ...files.filter((f) => readMode(state, f.path) !== "off").flatMap(contents),
      ...(files.some((f) => readMode(state, f.path) !== "off") ? [] : ["No additional read outputs selected."]),
    ];
    const invalidate = () => { wrapped = undefined; };
    const finish = (value: ReadRetention | undefined) => {
      if (finished) return;
      finished = true; signal.removeEventListener("abort", abort); done(value);
    };
    const abort = () => finish(undefined);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) queueMicrotask(abort);
    return {
      capturesViewportInput: true,
      render(width: number): string[] {
        const height = pageSize(), ordered = rows();
        const line = (text: string) => truncateToWidth(text, width);
        const selected = files.filter((f) => readMode(state, f.path) !== "off");
        const total = selected.reduce((n, f) => n + chars(f), 0);
        const out = [theme.fg("accent", theme.bold(`Read retention · ${preview === "review" ? "Review" : preview ? "Output preview" : "Select"}`)),
          theme.fg("muted", `${selected.length} files · ${total.toLocaleString()} output chars (~${Math.ceil(total / 4).toLocaleString()} tokens); tail/native duplicates omitted`),
          theme.fg("muted", preview ? "Historical outputs; retained independently of turn filtering." : `Order: ${latestOrder ? "latest" : "first"} read ascending · OFF / FIRST / LATEST`), ""];
        if (preview) {
          if (!wrapped || wrapped.width !== width) wrapped = { width, lines: previewLines().flatMap((s) => wrapTextWithAnsi(clean(s), Math.max(1, width))) };
          scroll = Math.max(0, Math.min(scroll, wrapped.lines.length - height));
          out.push(...wrapped.lines.slice(scroll, scroll + height));
        } else {
          cursor = Math.max(0, Math.min(cursor, ordered.length - 1));
          top = Math.max(0, Math.min(top, cursor, ordered.length - height));
          if (cursor >= top + height) top = cursor - height + 1;
          for (let i = top; i < Math.min(top + height, ordered.length); i++) {
            const file = ordered[i];
            const text = clean(`${i === cursor ? "›" : " "} ${heading(file)}`);
            out.push(i === cursor ? theme.bg("selectedBg", line(text)) : line(text));
          }
          if (!ordered.length) out.push("No successful text read outputs in this branch.");
        }
        out.push("", theme.fg("accent", preview ? "↑/↓ PgUp/PgDn Home/End: scroll · Esc: back" : "↑/↓: move · Space/f: mode · o: order · p/→: full preview · d: declared default"),
          theme.fg("accent", preview === "review" ? "Enter: confirm & save" : preview ? "←/Esc: back" : "Enter: review & save · Esc: cancel"));
        return out.map(line).slice(0, Math.max(1, tui.terminal.rows));
      },
      handleInput(data: string) {
        const ordered = rows(), file = ordered[cursor], page = pageSize();
        if (kb.matches(data, "tui.select.cancel") || (preview && matchesKey(data, Key.left))) {
          if (preview) { preview = undefined; scroll = 0; } else { finish(undefined); return; }
        } else if (preview) {
          if (preview === "review" && kb.matches(data, "tui.select.confirm")) { finish(state); return; }
          if (kb.matches(data, "tui.select.up")) scroll--;
          else if (kb.matches(data, "tui.select.down")) scroll++;
          else if (matchesKey(data, Key.pageUp)) scroll -= page;
          else if (matchesKey(data, Key.pageDown)) scroll += page;
          else if (matchesKey(data, Key.home)) scroll = 0;
          else if (matchesKey(data, Key.end)) scroll = Number.MAX_SAFE_INTEGER;
          // Keep the wrapped preview when only scrolling.
          tui.requestRender(); return;
        } else if (kb.matches(data, "tui.select.up")) cursor = Math.max(0, cursor - 1);
        else if (kb.matches(data, "tui.select.down")) cursor = Math.min(ordered.length - 1, cursor + 1);
        else if (matchesKey(data, Key.pageUp)) cursor = Math.max(0, cursor - page);
        else if (matchesKey(data, Key.pageDown)) cursor = Math.min(ordered.length - 1, cursor + page);
        else if (matchesKey(data, Key.home)) cursor = 0;
        else if (matchesKey(data, Key.end)) cursor = ordered.length - 1;
        else if (matchesKey(data, "o")) { latestOrder = !latestOrder; cursor = file ? rows().indexOf(file) : 0; top = 0; }
        else if (file && (matchesKey(data, Key.space) || matchesKey(data, "f"))) {
          const modes: ReadMode[] = ["off", "first", "latest"];
          state.overrides[file.path] = modes[(modes.indexOf(readMode(state, file.path)) + 1) % modes.length];
        } else if (file && matchesKey(data, "d")) delete state.overrides[file.path];
        else if (file && (matchesKey(data, "p") || matchesKey(data, Key.right))) { preview = "read"; scroll = 0; }
        else if (kb.matches(data, "tui.select.confirm")) { preview = "review"; scroll = 0; }
        invalidate(); tui.requestRender();
      },
      invalidate,
      dispose() { finished = true; signal.removeEventListener("abort", abort); },
    };
  });
}
