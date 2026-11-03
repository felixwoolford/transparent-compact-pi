export const NORMAL_PREVIEW_CHARS = 160;
export function headPrefix(text, max) {
  let end = Math.min(text.length, max);
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}
export function commandPreview(encoded) {
  return encoded.length <= NORMAL_PREVIEW_CHARS ? { head: encoded }
    : { head: headPrefix(encoded, NORMAL_PREVIEW_CHARS), truncated: true };
}
export function argumentSnippet(value) {
  let text;
  try { text = JSON.stringify(value) ?? String(value); } catch { text = String(value); }
  return text.length > NORMAL_PREVIEW_CHARS ? text.slice(0, NORMAL_PREVIEW_CHARS) + '…' : text;
}
export const checkpointPath = (value, cwd) => value === cwd ? '.'
  : value.startsWith(cwd.endsWith('/') ? cwd : cwd + '/') ? value.slice(cwd.endsWith('/') ? cwd.length : cwd.length + 1) : value;
export function checkpointCommand(command, cwd) {
  const escaped = cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return command.replace(new RegExp(`(^|[\\s"'=<>|;&(])${escaped}(?=$|[/\\s"'<>|;&)])`, 'g'), '$1.');
}
