export { selectToolInputs } from '../../extensions/lib/tool-stubs/inputs.mjs';

/** Baseline adapter only: separate its bash argument display from the appended
 * result annotations. Match the exact argument-derived prefix, never search for
 * status markers/arrow text that might also occur inside arguments or output.
 * File tools already place all argument display in prefix, not suffix.
 */
export function resultSuffix(call, baseline) {
  if (call.name !== 'bash' || !baseline.command) return baseline.suffix;
  const snippets = Object.entries(call.arguments ?? {}).filter(([key]) => key !== 'command' && key !== 'timeout')
    .map(([key, value]) => {
      const encoded = JSON.stringify(value) ?? String(value);
      return `${key}=${encoded.length > 160 ? encoded.slice(0, 160) + '…' : encoded}`;
    });
  const argumentPrefix = snippets.length ? ' ' + snippets.join(' ') : '';
  if (!baseline.suffix.startsWith(argumentPrefix)) throw new Error('Baseline bash argument display does not match original arguments');
  return baseline.suffix.slice(argumentPrefix.length);
}
