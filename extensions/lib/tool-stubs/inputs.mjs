// Known tools select payload, never infer which arbitrary extension fields are
// metadata. Unknown tools retain an agnostic bounded argument display.
const PAYLOAD_FIELDS = new Map([
  ['bash', new Set(['command'])],
  ['read', new Set(['path', 'offset', 'limit'])],
  ['write', new Set(['path', 'content'])],
  ['edit', new Set(['path', 'edits', 'oldText', 'newText'])],
]);
export function selectToolInputs(name, args = {}) {
  const fields = PAYLOAD_FIELDS.get(name);
  return fields ? Object.fromEntries(Object.entries(args ?? {}).filter(([key]) => fields.has(key))) : undefined;
}
