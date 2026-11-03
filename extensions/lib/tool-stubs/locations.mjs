import path from 'node:path';

/** Append-only, checkpoint-scoped identities. No filesystem access or expansion. */
export class Locations {
  constructor(cwd, entries = []) {
    this.cwd = cwd;
    this.entries = entries.map(entry => ({ ...entry }));
    this.byKey = new Map(this.entries.map(entry => [entry.key, entry]));
  }

  describe(value, cwd = this.cwd, kind = 'path', literal = false) {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) kind = 'url';
    const relative = cwd && value.startsWith(cwd + '/') ? value.slice(cwd.length + 1) : value === cwd ? '' : value;
    const dynamic = !literal && /[$`*?{}\[\]~]/.test(relative);
    // Unknown working directories remain explicitly scoped, never guessed.
    const resolved = kind !== 'path' ? value : dynamic || (!cwd && !path.posix.isAbsolute(value))
      ? `${cwd ?? '?'} :: ${value}` : path.posix.resolve(cwd ?? '/', value);
    const scope = cwd === this.cwd ? '.' : cwd?.startsWith(this.cwd + '/') ? cwd.slice(this.cwd.length + 1) : cwd ?? '?';
    const display = kind !== 'path' ? value : dynamic || (!cwd && !path.posix.isAbsolute(value)) ? `${scope} :: ${value}`
      : resolved === this.cwd ? '.' : resolved.startsWith(this.cwd + '/') ? resolved.slice(this.cwd.length + 1) : resolved;
    return { key: `${kind}:${resolved}`, kind, value: resolved, display };
  }

  ref(value, cwd = this.cwd, kind = 'path', literal = false) {
    const description = this.describe(value, cwd, kind, literal);
    let entry = this.byKey.get(description.key);
    if (!entry) {
      entry = { id: `@${this.entries.length + 1}`, ...description };
      this.entries.push(entry);
      this.byKey.set(entry.key, entry);
    }
    return entry;
  }

  render(ids) {
    const entries = ids ? this.entries.filter(entry => ids.has(entry.id)) : this.entries;
    if (!entries.length) return '';
    return ['<locations note="lexical references, not verified accesses; ? means unknown cwd">',
      ...entries.map(entry => `${entry.id} ${entry.kind !== 'path' ? entry.kind.toUpperCase() + ' ' : ''}${JSON.stringify(entry.display)}`),
      '</locations>'].join('\n');
  }
}
