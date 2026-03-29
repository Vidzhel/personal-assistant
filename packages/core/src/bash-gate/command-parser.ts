/**
 * Best-effort shell command parser for the bash gate.
 * Not a full POSIX parser — errs on the side of extracting more paths (false positives OK).
 */

export interface ParsedCommand {
  binary: string;
  args: string[];
  paths: string[];
}

export interface ParsedCommandChain {
  commands: ParsedCommand[];
  allBinaries: string[];
  allPaths: string[];
  raw: string;
}

const PATH_RE = /[/.]|\.[\w]+$/;
const CHAIN_SPLIT_RE = /\s*(?:\|\||&&|[|;])\s*/;
const REDIRECT_RE = /^>{1,2}$|^<$/;
const ATTACHED_REDIRECT_OUT_RE = /^>{1,2}.+/;
const ATTACHED_REDIRECT_IN_RE = /^<.+/;
const SUBSHELL_PREFIX = '__subshell__:';

/** Read a quoted string starting after the opening quote. Returns the new index. */
function readQuoted(input: string, start: number, quote: string): { text: string; end: number } {
  let text = '';
  let i = start;
  while (i < input.length && input[i] !== quote) {
    text += input[i];
    i++;
  }
  return { text, end: i + 1 }; // skip closing quote
}

/** Read a $(...) subshell starting after the `$(`. Returns the inner text and new index. */
function readSubshell(input: string, start: number): { inner: string; end: number } {
  let depth = 1;
  let i = start;
  let inner = '';
  while (i < input.length && depth > 0) {
    if (input[i] === '(') depth++;
    else if (input[i] === ')') {
      depth--;
      if (depth === 0) return { inner, end: i + 1 };
    }
    inner += input[i];
    i++;
  }
  return { inner, end: i };
}

/** Tokenize a command string, respecting quoted strings and subshells. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === '"' || ch === "'") {
      const result = readQuoted(input, i + 1, ch);
      current += result.text;
      i = result.end;
    } else if (ch === '$' && input[i + 1] === '(') {
      const result = readSubshell(input, i + 2);
      current += `${SUBSHELL_PREFIX}${result.inner}`;
      i = result.end;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      i++;
    } else {
      current += ch;
      i++;
    }
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function looksLikePath(token: string): boolean {
  if (token.startsWith('-') && !token.startsWith('-/') && !token.startsWith('-.')) {
    return false;
  }
  return PATH_RE.test(token);
}

/** Extract a path from a single arg, returning the path or null. Advances index via callback. */
function extractPathFromArg(
  arg: string,
  nextArg: string | undefined,
): { path: string | null; skip: boolean } {
  if (arg.startsWith(SUBSHELL_PREFIX)) {
    const inner = arg.slice(SUBSHELL_PREFIX.length);
    // Return a sentinel — caller will handle recursive parsing
    return { path: `__recurse__:${inner}`, skip: false };
  }

  if (REDIRECT_RE.test(arg) && nextArg && !nextArg.startsWith(SUBSHELL_PREFIX)) {
    return { path: nextArg, skip: true };
  }

  if (ATTACHED_REDIRECT_OUT_RE.test(arg)) {
    return { path: arg.replace(/^>{1,2}/, ''), skip: false };
  }
  if (ATTACHED_REDIRECT_IN_RE.test(arg)) {
    return { path: arg.replace(/^</, ''), skip: false };
  }

  return { path: looksLikePath(arg) ? arg : null, skip: false };
}

function resolvePathResult(path: string): string[] {
  if (path.startsWith('__recurse__:')) {
    return parseCommand(path.slice('__recurse__:'.length)).allPaths;
  }
  return [path];
}

function collectArgPaths(args: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const result = extractPathFromArg(args[i], args[i + 1]);
    if (result.skip) i++;
    if (result.path) paths.push(...resolvePathResult(result.path));
  }
  return paths;
}

function addCdTarget(binary: string, args: string[], paths: string[]): void {
  if (binary !== 'cd' || args.length === 0 || args[0].startsWith('-')) return;
  if (args[0].startsWith(SUBSHELL_PREFIX)) return;
  if (!paths.includes(args[0])) paths.push(args[0]);
}

function parseSingleCommand(tokens: string[]): ParsedCommand {
  if (tokens.length === 0) return { binary: '', args: [], paths: [] };

  const binary = tokens[0];
  const args = tokens.slice(1);
  const paths = collectArgPaths(args);
  addCdTarget(binary, args, paths);

  return { binary, args, paths };
}

/**
 * Parse a shell command string into a chain of parsed commands.
 * Splits on |, &&, ||, ; and parses each segment.
 */
export function parseCommand(command: string): ParsedCommandChain {
  const raw = command.trim();
  if (raw.length === 0) return { commands: [], allBinaries: [], allPaths: [], raw: '' };

  const segments = raw.split(CHAIN_SPLIT_RE).filter(Boolean);
  const commands: ParsedCommand[] = [];

  for (const segment of segments) {
    const tokens = tokenize(segment.trim());
    if (tokens.length > 0) commands.push(parseSingleCommand(tokens));
  }

  const allBinaries = commands.map((c) => c.binary).filter(Boolean);
  const allPaths = commands.flatMap((c) => c.paths);

  return { commands, allBinaries, allPaths, raw };
}
