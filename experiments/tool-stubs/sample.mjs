import fs from 'node:fs/promises';
import path from 'node:path';

/** Bounded byte-window sampling, never a SessionManager open/migration. Partial
 * boundary records are skipped. Samples are raw excerpts, NOT an active branch.
 */
export async function sampleSession(file, { windowBytes = 393216, windows = 4 } = {}) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat(), header = Buffer.alloc(Math.min(65536, stat.size));
    await handle.read(header, 0, header.length, 0);
    const end = header.indexOf(10);
    if (end < 0) throw new Error(`Session header exceeds 64 KiB: ${file}`);
    const session = JSON.parse(header.subarray(0, end).toString());
    if (session.type !== 'session' || typeof session.cwd !== 'string') throw new Error(`Invalid session header: ${file}`);
    const records = new Map(), ranges = [];
    for (let i = 0; i < windows; i++) {
      const start = windows === 1 ? 0 : Math.floor(Math.max(0, stat.size - windowBytes) * i / (windows - 1));
      const buffer = Buffer.alloc(Math.min(windowBytes, stat.size - start));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const data = buffer.subarray(0, bytesRead);
      // Check the preceding byte so a window starting exactly at a record keeps it.
      const previous = Buffer.alloc(1);
      if (start) await handle.read(previous, 0, 1, start - 1);
      let from = start === 0 || previous[0] === 10 ? 0 : data.indexOf(10) + 1;
      let parsed = 0, invalid = 0;
      if (from === 0 && start && previous[0] !== 10) from = data.length;
      while (from < data.length) {
        let to = data.indexOf(10, from);
        if (to < 0) {
          if (start + bytesRead !== stat.size) break;
          to = data.length;
        }
        const offset = start + from;
        if (to > from && !records.has(offset)) {
          try { records.set(offset, { offset, entry: JSON.parse(data.subarray(from, to).toString('utf8')) }); parsed++; }
          catch { invalid++; }
        }
        from = to + 1;
      }
      ranges.push({ start, end: start + bytesRead, parsedRecords: parsed, invalidRecords: invalid });
    }
    return { file: path.resolve(file), cwd: session.cwd, size: stat.size, ranges,
      records: [...records.values()].sort((a, b) => a.offset - b.offset) };
  } finally { await handle.close(); }
}

export async function selectSessions(inputs, sessionsPerDir = 2) {
  const files = [];
  for (const input of inputs) {
    const stat = await fs.stat(input);
    if (!stat.isDirectory()) { files.push(path.resolve(input)); continue; }
    const candidates = (await fs.readdir(input)).filter(name => name.endsWith('.jsonl')).sort();
    // Deterministic spread across names; no content reads while selecting.
    const count = Math.min(sessionsPerDir, candidates.length);
    for (let i = 0; i < count; i++) {
      const at = Math.min(candidates.length - 1, Math.floor((i + 0.5) * candidates.length / count));
      files.push(path.resolve(input, candidates[at]));
    }
  }
  return [...new Set(files)];
}
