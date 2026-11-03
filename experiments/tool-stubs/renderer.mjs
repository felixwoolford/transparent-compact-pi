import { ToolRenderer, TOOL_DISPLAY_EXPLANATION } from '../../extensions/lib/tool-stubs/renderer.mjs';
import { selectToolInputs, resultSuffix } from './tool-inputs.mjs';
export { checkpointPath } from '../../extensions/lib/tool-stubs/display.mjs';

export const EXPERIMENT_LEGEND = TOOL_DISPLAY_EXPLANATION;
export const renderBaseline = stub => stub.prefix + (stub.command
  ? stub.command.head + (stub.command.truncated ? '…' : '') : '') + stub.suffix;

/** Thin offline adapter: the candidate is the exact live renderer, while the
 * baseline supplies historical status/output labels from the pinned old hook.
 */
export class SkeletonRenderer extends ToolRenderer {
  async render(call, baseline) {
    if (selectToolInputs(call.name, call.arguments) === undefined)
      return { text: renderBaseline(baseline), mode: 'unchanged', cues: [], refs: [] };
    const { stub, ...diagnostics } = await this.describe(call.name, call.arguments, resultSuffix(call, baseline));
    return { text: renderBaseline(stub), ...diagnostics };
  }
}

/** Per-call lexical visibility only, not semantic-accuracy/outcome measurement. */
export function auditCues(baseline, candidate) {
  const text = renderBaseline(baseline);
  const encode = value => JSON.stringify(value).slice(1, -1);
  const unique = new Map(candidate.cues.map(cue => [`${cue.kind}:${cue.value}`, cue]));
  return [...unique.values()].map(cue => ({ ...cue,
    baselineVisible: [cue.value, cue.display].filter(Boolean).some(value => text.includes(encode(value))),
    candidateVisible: cue.id ? candidate.refs.includes(cue.id) : candidate.text.includes(cue.value),
  }));
}
