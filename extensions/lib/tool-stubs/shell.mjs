import path from 'node:path';
import { parse } from '@questi0nm4rk/shell-ast';

const PATH_COMMANDS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'tree', 'stat', 'file', 'du',
  'cp', 'mv', 'install', 'rm', 'mkdir', 'touch', 'tee', 'diff', 'cmp', 'readlink', 'realpath']);
const SUBCOMMANDS = new Set(['git', 'cargo', 'npm', 'pnpm', 'yarn', 'go', 'docker', 'tmux', 'uv']);
const VALUE_FLAGS = new Set(['-m', '-j', '--max-count', '--context',
  '--glob', '-g', '--include', '--exclude', '--exclude-dir', '--color', '--max-time', '--connect-timeout',
  '-H', '--header', '-w', '--write-out', '-X', '--request', '-u', '--user', '--features', '--bin',
  '--dt', '--duration', '--record-every', '--target', '--model', '--provider']);
const PATH_FLAGS = new Set(['-o', '--output', '-T', '--upload-file', '-K', '--config',
  '--cacert', '--cert', '--key', '--output-dir', '--directory', '--manifest-path']);
const SCRIPT_FLAGS = new Set(['-c', '-e', '--eval']);
const GIT_PATH_COMMANDS = new Set(['add', 'diff', 'status', 'restore', 'rm', 'mv', 'ls-files', 'checkout']);
const DATA_FLAGS = new Set(['-d', '--data', '--data-binary', '--data-raw', '--data-urlencode']);
const INTERPRETER = /^(?:python[\d.]*|node|ruby|perl|bash|sh)$/;
export const looksLikeLocation = value => !!value && !/[\n\r\x00]/.test(value) &&
  (/^[a-z][a-z\d+.-]*:\/\//i.test(value) ||
    (!/[;|<>()=:]/.test(value) && (/^(?:\.{1,2}(?:\/|$)|\/|~\/)/.test(value) ||
      /\//.test(value) || /\.[a-z][a-z\d_-]{0,12}$/i.test(value))));

// AST positions are UTF-8 byte offsets, not JS string indices.
const sourceText = (source, node) => source.subarray(node.pos.offset, node.end.offset).toString('utf8');
const expression = (source, node) => {
  const raw = sourceText(source, node);
  return /^(["']).*\1$/s.test(raw) ? raw.slice(1, -1) : raw;
};
function literal(word) {
  if (!word?.parts) return null;
  let out = '';
  for (const part of word.parts) {
    if (part.type === 'Lit') out += part.value.replace(/\\([^\n])/g, '$1').replace(/\\\n/g, '');
    else if (part.type === 'SglQuoted' && !part.dollar) out += part.value;
    else if (part.type === 'DblQuoted' && !part.dollar) {
      let text = '';
      for (const item of part.parts ?? []) {
        if (item.type !== 'Lit') return null;
        text += item.value.replace(/\\([$`"\\])/g, '$1').replace(/\\\n/g, '');
      }
      out += text;
    } else return null;
  }
  return out;
}

/** Pure static description: never runs commands, opens paths, or expands globs. */
export async function shellSkeleton(command, locations, options = {}) {
  const { maxBytes = 262144, maxNodes = 2048, maxMentions = 8, parseShell = parse } = options;
  const ast = await parseShell(command, 'bash', { maxBytes });
  const source = Buffer.from(command);
  const cues = [], refs = new Set();
  let visited = 0;
  const tick = () => { if (++visited > maxNodes) throw new Error('AST node budget exceeded'); };
  const cue = (kind, value) => { cues.push({ kind, value }); return value; };
  const location = (value, state, kind = 'path') => {
    const entry = locations.ref(value, state.cwd, kind);
    refs.add(entry.id);
    cues.push({ kind: entry.kind, value, display: entry.display, id: entry.id });
    return entry.id;
  };
  const operator = value => cue('operator', value);
  const join = statements => statements.filter(Boolean).join('; ');
  const copy = state => ({ ...state });

  function mentions(body, state) {
    const found = new Set();
    // Literal-looking quoted strings only; intentionally not a Python/JS parser.
    for (const match of body.slice(0, 65536).matchAll(/(["'])([^"'\\\n]*(?:\\.[^"'\\\n]*)*)\1/g)) {
      const value = match[2];
      if (looksLikeLocation(value)) found.add(value);
      if (found.size > maxMentions) break;
    }
    const selected = [...found].slice(0, maxMentions).map(value => location(value, state));
    return selected.length ? ` mentions ${selected.join(',')}${found.size > maxMentions ? ',…' : ''}` : '';
  }

  function nested(node, state) {
    if (!node || typeof node !== 'object') return [];
    tick();
    if (node.type === 'CmdSubst' || node.type === 'ProcSubst')
      return [`${node.type === 'CmdSubst' ? '$(' : node.op + '('}${list(node.stmts, copy(state))})`];
    return Object.values(node).flatMap(value => Array.isArray(value)
      ? value.flatMap(item => nested(item, state)) : value && typeof value === 'object' ? nested(value, state) : []);
  }

  function call(node, state) {
    const words = node.args ?? [];
    const values = words.map(literal);
    const name = values[0] === null ? '[dynamic command]' : path.posix.basename(values[0] ?? '[assign]');
    if (name.length > 160) throw new Error('command name exceeds display budget');
    let text = cue('command', name);
    if (values[0]?.includes('/')) text += `[${location(values[0], state)}]`;
    if (name === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(values[1] ?? '') && words.length > 2)
      return `${text} ${call({ ...node, args: words.slice(2) }, state)}`;
    if (name === 'uv' && values[1] === 'run' && values[2] && !values[2].startsWith('-'))
      return `${text} ${cue('subcommand', 'run')} ${call({ ...node, args: words.slice(2) }, state)}`;
    if (name === 'env' && values[1] && !values[1].startsWith('-')) {
      const start = values.findIndex((value, index) => index > 0 && value && !value.includes('='));
      if (start > 0) return `${text} ${call({ ...node, args: words.slice(start) }, state)}`;
    }
    let pattern = ['sed', 'awk', 'grep', 'rg'].includes(name);
    let afterDash = false, needsSubcommand = SUBCOMMANDS.has(name), verb = null;
    let cdTarget = null;
    for (let i = 1; i < words.length; i++) {
      const value = values[i], raw = expression(source, words[i]);
      if (value === '--') { afterDash = true; continue; }
      if (value?.startsWith('-') && !afterDash) {
        if (name === 'find') break; // Roots precede the find expression.
        const equal = value.indexOf('=');
        const flag = equal < 0 ? value : value.slice(0, equal);
        const argument = equal < 0 ? values[i + 1] : value.slice(equal + 1);
        if (INTERPRETER.test(name) && (SCRIPT_FLAGS.has(flag) || (name === 'node' && flag === '-p'))) {
          if (argument !== undefined) {
            text += ` [inline${mentions(argument ?? sourceText(source, words[i + 1]), state)}]`;
            if (equal < 0) i++;
          }
        } else if ((PATH_FLAGS.has(flag) && (!/^-[oTK]$/.test(flag) || name === 'curl')) ||
          (flag === '-f' && ['sed', 'awk', 'grep', 'rg'].includes(name))) {
          if (argument !== undefined) text += ` ${location(argument ?? expression(source, words[i + 1]), state)}`;
          if (equal < 0) i++;
          if (flag === '-f') pattern = false;
        } else if (DATA_FLAGS.has(flag) && name === 'curl') {
          if (argument?.startsWith('@')) text += ` ${location(argument.slice(1), state)}`;
          if (equal < 0) i++;
        } else if (flag === '-e' && pattern) {
          pattern = false;
          if (equal < 0) i++;
        } else if (VALUE_FLAGS.has(flag) || (['-n', '-c'].includes(flag) && ['head', 'tail'].includes(name)) ||
          (['-A', '-B', '-C'].includes(flag) && ['grep', 'rg'].includes(name)) ||
          (flag === '-c' && name === 'git') || (flag === '-t' && name === 'tmux') || (flag === '-v' && name === 'awk')) {
          if (equal < 0) i++;
        }
        continue;
      }
      if (needsSubcommand && value && /^[\w-]+$/.test(value)) {
        text += ` ${cue('subcommand', value)}`;
        needsSubcommand = false;
        verb = value;
      } else if (pattern) pattern = false;
      else if (name === 'curl' && value && /^(?:[a-z][a-z\d+.-]*:\/\/|(?:[\w-]+\.)+[a-z]{2,}(?:[:/]|$)|localhost(?=[:/]|$))/i.test(value))
        text += ` ${location(value, state, 'url')}`;
      else if (name === 'git' && value && /^[^:]+:.+/.test(value) && verb === 'show')
        text += ` ${location(value, state, 'git')}`;
      else if (value !== '-' && value !== null && (name === 'cd' || PATH_COMMANDS.has(name) ||
        ['sed', 'awk', 'grep', 'rg', 'find'].includes(name) ||
        (name === 'git' ? afterDash || (GIT_PATH_COMMANDS.has(verb) && (verb === 'add' || looksLikeLocation(value)))
          : looksLikeLocation(value)))) {
        text += ` ${location(value, state)}`;
        if (name === 'cd') cdTarget = value;
      } else if (value === null && looksLikeLocation(raw) && !raw.includes('$(') && !raw.includes('`')) {
        text += ` ${location(raw, state)}`;
      }
    }
    // Substitutions may be in arguments that were otherwise discarded as flags/patterns.
    for (const word of words) for (const expansion of nested(word, state)) text += ` ${expansion}`;
    for (const assignment of node.assigns ?? []) {
      for (const expansion of nested(assignment, state)) text += ` ${expansion}`;
    }
    if (name === 'cd') {
      state.cwd = cdTarget && !/[$`*?{}\[\]~]/.test(cdTarget) && (state.cwd || cdTarget.startsWith('/'))
        ? path.posix.resolve(state.cwd ?? '/', cdTarget) : null;
    }
    return text;
  }

  function stmt(node, state) {
    tick();
    if (!node) return '';
    const initial = copy(state);
    let text = render(node.cmd, node.background ? copy(state) : state);
    if (node.negated) text = `! ${text}`;
    // Redirections resolve before a command changes cwd.
    for (const redirect of node.redirs ?? []) {
      if (redirect.hdoc) {
        const body = literal(redirect.hdoc) ?? sourceText(source, redirect.hdoc);
        text += ` [body${mentions(body, initial)}]`;
        for (const expansion of nested(redirect.hdoc, initial)) text += ` ${expansion}`;
      } else {
        const value = literal(redirect.word), raw = expression(source, redirect.word);
        const expansions = nested(redirect.word, initial);
        const fd = redirect.n?.value ?? '';
        if (redirect.op === '<<<') {
          text += ` ${operator('<<<')}[stdin${mentions(value ?? raw, initial)}]`;
        } else {
          const destination = /[<>]&/.test(redirect.op) && /^\d+-?$|^-$/.test(value ?? '')
            ? value : value === null && expansions.length ? '[dynamic]' : location(value ?? raw, initial);
          text += ` ${operator(fd + redirect.op)}${destination}`;
        }
        for (const expansion of expansions) text += ` ${expansion}`;
      }
    }
    if (node.background) text += ` ${operator('&')}`;
    return text;
  }

  function list(nodes = [], state) { return join(nodes.map(node => stmt(node, state))); }
  function render(node, state) {
    tick();
    if (!node) return '[assignment]';
    switch (node.type) {
      case 'CallExpr': return call(node, state);
      case 'BinaryCmd': {
        const before = copy(state), leftState = copy(state);
        const left = stmt(node.x, leftState);
        const rightState = copy(node.op === '&&' ? leftState : before);
        const right = stmt(node.y, rightState);
        // An enclosing && RHS is reached only after the left chain succeeded.
        // Track that lexical success-path cwd; no claim about observed execution.
        state.cwd = node.op === '&&' ? rightState.cwd : leftState.cwd === rightState.cwd ? leftState.cwd : null;
        if (node.op === '|' || node.op === '|&') state.cwd = before.cwd;
        return `${left} ${operator(node.op)} ${right}`;
      }
      case 'Subshell': return `(${list(node.stmts, copy(state))})`;
      case 'Block': return `{${list(node.stmts, state)}}`;
      case 'IfClause': {
        const yes = copy(state), no = copy(state);
        const condition = list(node.cond, yes);
        const then = list(node.then, yes);
        const otherwise = node.else ? render(node.else, no) : '';
        state.cwd = yes.cwd === no.cwd ? yes.cwd : null;
        return condition ? `if{${condition}} then{${then}}${otherwise ? ` else{${otherwise}}` : ''}` : then;
      }
      case 'ForClause': {
        const loopState = copy(state);
        const body = list(node.do, loopState);
        if (loopState.cwd !== state.cwd) state.cwd = null;
        return `for{${body}}`;
      }
      case 'WhileClause': {
        const local = copy(state), condition = list(node.cond, local), body = list(node.do, local);
        if (local.cwd !== state.cwd) state.cwd = null;
        return `${node.until ? 'until' : 'while'}{${condition}} do{${body}}`;
      }
      case 'CaseClause': {
        const body = node.items.map(item => `{${list(item.stmts, copy(state))}}`).join('; ');
        state.cwd = null;
        return `case{${body}}`;
      }
      case 'FuncDecl': return `function ${node.name.value}{${stmt(node.body, { cwd: null })}}`;
      case 'TimeClause': return `time ${stmt(node.stmt, state)}`;
      case 'TestClause': return '[[test]]';
      case 'ArithmCmd': return '((arithmetic))';
      default: throw new Error(`unsupported AST node: ${node.type}`);
    }
  }

  const text = list(ast.stmts, { cwd: locations.cwd });
  return { text, cues, refs: [...refs], nodes: visited };
}
