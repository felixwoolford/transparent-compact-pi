import path from 'node:path';
import { parseShell as parse } from './parse.mjs';

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
const MAX_AST_NODES = 2048;
const MAX_BODY_MENTIONS = 8;
const looksLikeLocation = value => !!value && !/[\n\r\x00]/.test(value) &&
  (/^[a-z][a-z\d+.-]*:\/\//i.test(value) ||
    (!/[;|<>()=:]/.test(value) && (/^(?:\.{1,2}(?:\/|$)|\/|~\/)/.test(value) ||
      /\//.test(value) || /\.[a-z][a-z\d_-]{0,12}$/i.test(value))));

// AST positions are UTF-8 byte offsets, not JS string indices.
const sourceText = (source, node) => source.subarray(node.Pos.Offset, node.End.Offset).toString('utf8');
const expression = (source, node) => {
  const raw = sourceText(source, node);
  return /^(["']).*\1$/s.test(raw) ? raw.slice(1, -1) : raw;
};
function literal(word) {
  if (!word?.Parts) return null;
  let out = '';
  for (const part of word.Parts) {
    if (part.Type === 'Lit') out += (part.Value ?? '').replace(/\\([^\n])/g, '$1').replace(/\\\n/g, '');
    else if (part.Type === 'SglQuoted' && !part.Dollar) out += part.Value ?? '';
    else if (part.Type === 'DblQuoted' && !part.Dollar) {
      let text = '';
      for (const item of part.Parts ?? []) {
        if (item.Type !== 'Lit') return null;
        text += (item.Value ?? '').replace(/\\([$`"\\])/g, '$1').replace(/\\\n/g, '');
      }
      out += text;
    } else return null;
  }
  return out;
}

/** Pure static description: never runs commands, opens paths, or expands globs. */
export async function shellSkeleton(command, locations) {
  const ast = await parse(command);
  const source = Buffer.from(command);
  const refs = new Set();
  let visited = 0;
  const tick = () => { if (++visited > MAX_AST_NODES) throw new Error('AST node budget exceeded'); };
  const location = (value, state, kind = 'path') => {
    const entry = locations.ref(value, state.cwd, kind);
    refs.add(entry.id);
    return entry.id;
  };
  const join = statements => statements.filter(Boolean).join('; ');
  const copy = state => ({ ...state });

  function mentions(body, state) {
    const found = new Set();
    // Literal-looking quoted strings only; intentionally not a Python/JS parser.
    for (const match of body.slice(0, 65536).matchAll(/(["'])([^"'\\\n]*(?:\\.[^"'\\\n]*)*)\1/g)) {
      const value = match[2];
      if (looksLikeLocation(value)) found.add(value);
      if (found.size > MAX_BODY_MENTIONS) break;
    }
    const selected = [...found].slice(0, MAX_BODY_MENTIONS).map(value => location(value, state));
    return selected.length ? ` mentions ${selected.join(',')}${found.size > MAX_BODY_MENTIONS ? ',…' : ''}` : '';
  }

  function nested(node, state) {
    if (!node || typeof node !== 'object') return [];
    // Upstream JSON includes several source-position fields per node. They are
    // coordinates, not nested syntax, and must not consume the AST node budget.
    if (typeof node.Offset === 'number' && typeof node.Line === 'number' && typeof node.Col === 'number') return [];
    tick();
    if (node.Type === 'CmdSubst' || node.Type === 'ProcSubst')
      return [`${node.Type === 'CmdSubst' ? '$(' : node.Op}${list(node.Stmts, copy(state))})`];
    return Object.values(node).flatMap(value => Array.isArray(value)
      ? value.flatMap(item => nested(item, state)) : value && typeof value === 'object' ? nested(value, state) : []);
  }

  function call(node, state) {
    const words = node.Args ?? [];
    const values = words.map(literal);
    const name = values[0] === null ? '[dynamic command]' : path.posix.basename(values[0] ?? '[assign]');
    if (name.length > 160) throw new Error('command name exceeds display budget');
    let text = name;
    if (values[0]?.includes('/')) text += `[${location(values[0], state)}]`;
    if (name === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(values[1] ?? '') && words.length > 2)
      return `${text} ${call({ ...node, Args: words.slice(2) }, state)}`;
    if (name === 'uv' && values[1] === 'run' && values[2] && !values[2].startsWith('-'))
      return `${text} run ${call({ ...node, Args: words.slice(2) }, state)}`;
    if (name === 'env' && values[1] && !values[1].startsWith('-')) {
      const start = values.findIndex((value, index) => index > 0 && value && !value.includes('='));
      if (start > 0) return `${text} ${call({ ...node, Args: words.slice(start) }, state)}`;
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
        text += ` ${value}`;
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
    for (const assignment of node.Assigns ?? []) {
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
    let text = render(node.Cmd, node.Background ? copy(state) : state);
    if (node.Negated) text = `! ${text}`;
    // Redirections resolve before a command changes cwd.
    for (const redirect of node.Redirs ?? []) {
      if (redirect.Hdoc) {
        const body = literal(redirect.Hdoc) ?? sourceText(source, redirect.Hdoc);
        text += ` [body${mentions(body, initial)}]`;
        for (const expansion of nested(redirect.Hdoc, initial)) text += ` ${expansion}`;
      } else {
        const value = literal(redirect.Word), raw = expression(source, redirect.Word);
        const expansions = nested(redirect.Word, initial);
        const fd = redirect.N?.Value ?? '';
        if (redirect.Op === '<<<') {
          text += ` <<<[stdin${mentions(value ?? raw, initial)}]`;
        } else {
          const destination = /[<>]&/.test(redirect.Op) && /^\d+-?$|^-$/.test(value ?? '')
            ? value : value === null && expansions.length ? '[dynamic]' : location(value ?? raw, initial);
          text += ` ${fd}${redirect.Op}${destination}`;
        }
        for (const expansion of expansions) text += ` ${expansion}`;
      }
    }
    if (node.Background) text += ' &';
    return text;
  }

  function list(nodes = [], state) { return join(nodes.map(node => stmt(node, state))); }
  function render(node, state, type = node?.Type) {
    tick();
    if (!node) return '[assignment]';
    switch (type) {
      case 'CallExpr': return call(node, state);
      case 'BinaryCmd': {
        const before = copy(state), leftState = copy(state);
        const left = stmt(node.X, leftState);
        const rightState = copy(node.Op === '&&' ? leftState : before);
        const right = stmt(node.Y, rightState);
        // An enclosing && RHS is reached only after the left chain succeeded.
        // Track that lexical success-path cwd; no claim about observed execution.
        state.cwd = node.Op === '&&' ? rightState.cwd : leftState.cwd === rightState.cwd ? leftState.cwd : null;
        if (node.Op === '|' || node.Op === '|&') state.cwd = before.cwd;
        return `${left} ${node.Op} ${right}`;
      }
      case 'Subshell': return `(${list(node.Stmts, copy(state))})`;
      case 'Block': return `{${list(node.Stmts, state)}}`;
      case 'IfClause': {
        const yes = copy(state), no = copy(state);
        const condition = list(node.Cond, yes);
        const then = list(node.Then, yes);
        // Else is a concrete *IfClause, so upstream JSON omits its Type.
        const otherwise = node.Else ? render(node.Else, no, 'IfClause') : '';
        state.cwd = yes.cwd === no.cwd ? yes.cwd : null;
        return condition ? `if{${condition}} then{${then}}${otherwise ? ` else{${otherwise}}` : ''}` : then;
      }
      case 'ForClause': {
        const loopState = copy(state);
        const body = list(node.Do, loopState);
        if (loopState.cwd !== state.cwd) state.cwd = null;
        return `for{${body}}`;
      }
      case 'WhileClause': {
        const local = copy(state), condition = list(node.Cond, local), body = list(node.Do, local);
        if (local.cwd !== state.cwd) state.cwd = null;
        return `${node.Until ? 'until' : 'while'}{${condition}} do{${body}}`;
      }
      case 'CaseClause': {
        const body = (node.Items ?? []).map(item => `{${list(item.Stmts, copy(state))}}`).join('; ');
        state.cwd = null;
        return `case{${body}}`;
      }
      case 'FuncDecl': return `function ${node.Name.Value}{${stmt(node.Body, { cwd: null })}}`;
      case 'TimeClause': return `time ${stmt(node.Stmt, state)}`;
      case 'TestClause': return '[[test]]';
      case 'ArithmCmd': return '((arithmetic))';
      default: throw new Error(`unsupported AST node: ${type}`);
    }
  }

  const text = list(ast.Stmts, { cwd: locations.cwd });
  return { text, refs: [...refs] };
}
