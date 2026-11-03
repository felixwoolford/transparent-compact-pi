import { Locations } from './locations.mjs';
import { shellSkeleton } from './shell.mjs';
import { selectToolInputs } from './inputs.mjs';
import { argumentSnippet, checkpointCommand, commandPreview } from './display.mjs';

export const TOOL_DISPLAY_EXPLANATION = '- In the compacted spans, user and assistant prose is kept verbatim, subject to budget trimming. Retained prose is a record of what was said, not verification of its claims. Tool signatures are display notation, not replayable commands. @N refers to the shared location dictionary near the end of this checkpoint. Known tools retain selected payload fields only; other call arguments are omitted. Short quoted bash commands remain literal (with working-directory shortening); bash{...} is a lossy shell skeleton retaining commands, locations and shell connections, not flags or full arguments. [inline]/[body] omit program text; mentions are lexical clues, not verified accesses. Requested read ranges and write/edit sizes/counts are not output coverage. Thinking and most output are removed; selected output observations remain after →.';

/** Produce bounded display records directly from projected arguments. No raw
 * command/program text is saved beyond a short literal preview or skeleton.
 * Outcome suffixes are supplied by the existing selected-result detector.
 */
export class ToolRenderer {
  constructor(cwd, { entries = [] } = {}) {
    this.locations = new Locations(cwd, entries);
  }

  async render(name, originalArgs = {}, suffix = '') {
    const args = selectToolInputs(name, originalArgs);
    if (args === undefined) return {
      prefix: `${name}(${Object.entries(originalArgs ?? {}).map(([key, value]) => `${key}=${argumentSnippet(value)}`).join(', ')})`, suffix,
    };
    if (name !== 'bash') {
      if (typeof args.path !== 'string') return { prefix: `${name} [path unavailable]`, suffix };
      const entry = this.locations.ref(args.path, this.locations.cwd, 'path', true);
      let detail = '';
      if (name === 'read' && (args.offset !== undefined || args.limit !== undefined) &&
        (args.offset === undefined || (Number.isSafeInteger(args.offset) && args.offset > 0)) &&
        (args.limit === undefined || (Number.isSafeInteger(args.limit) && args.limit > 0))) {
        const start = args.offset ?? 1;
        detail = `:${start}-${args.limit === undefined ? '' : start + args.limit - 1}`;
      }
      if (name === 'write' && typeof args.content === 'string') detail = ` (${args.content.length} chars)`;
      if (name === 'edit') {
        if (Array.isArray(args.edits)) detail += ` ×${args.edits.length}`;
        for (const key of ['oldText', 'newText'])
          if (typeof args[key] === 'string') detail += ` ${key}=<${args[key].length} chars>`;
      }
      return { prefix: `${name} ${entry.id}${detail}`, suffix, locations: [entry.id] };
    }
    if (typeof args.command !== 'string') return { prefix: 'bash [command unavailable]', suffix };
    const literal = commandPreview(JSON.stringify(checkpointCommand(args.command, this.locations.cwd)));
    const fallback = { prefix: 'bash ', command: literal, suffix };
    if (!literal.truncated) return fallback;
    const mark = this.locations.entries.length;
    try {
      const skeleton = await shellSkeleton(args.command, this.locations);
      return { prefix: `bash{${skeleton.text}}`, suffix, locations: skeleton.refs };
    } catch {
      for (const entry of this.locations.entries.splice(mark)) this.locations.byKey.delete(entry.key);
      return fallback;
    }
  }
}
