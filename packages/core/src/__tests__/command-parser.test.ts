import { describe, it, expect } from 'vitest';
import { parseCommand } from '../bash-gate/command-parser.ts';

describe('parseCommand', () => {
  it('extracts binary and args from simple command', () => {
    const result = parseCommand('ls -la /tmp');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].binary).toBe('ls');
    expect(result.commands[0].args).toEqual(['-la', '/tmp']);
  });

  it('extracts file paths from args', () => {
    const result = parseCommand('cp /src/file.ts /dest/file.ts');
    expect(result.allPaths).toContain('/src/file.ts');
    expect(result.allPaths).toContain('/dest/file.ts');
  });

  it('handles piped commands', () => {
    const result = parseCommand('cat /tmp/log.txt | grep error');
    expect(result.commands).toHaveLength(2);
    expect(result.allBinaries).toEqual(['cat', 'grep']);
    expect(result.allPaths).toContain('/tmp/log.txt');
  });

  it('handles chained commands with &&', () => {
    const result = parseCommand('mkdir /tmp/out && cp file.ts /tmp/out/');
    expect(result.commands).toHaveLength(2);
    expect(result.allBinaries).toEqual(['mkdir', 'cp']);
    expect(result.allPaths).toContain('/tmp/out');
    expect(result.allPaths).toContain('file.ts');
    expect(result.allPaths).toContain('/tmp/out/');
  });

  it('handles chained commands with ;', () => {
    const result = parseCommand('echo start; ls /var');
    expect(result.commands).toHaveLength(2);
    expect(result.allBinaries).toContain('echo');
    expect(result.allBinaries).toContain('ls');
  });

  it('handles quoted strings as single tokens', () => {
    const result = parseCommand('echo "hello world" file.txt');
    expect(result.commands[0].args).toEqual(['hello world', 'file.txt']);
    // "hello world" is not a path; file.txt is
    expect(result.allPaths).toContain('file.txt');
    expect(result.allPaths).not.toContain('hello world');
  });

  it('handles single-quoted strings', () => {
    const result = parseCommand("echo 'hello world'");
    expect(result.commands[0].args).toEqual(['hello world']);
  });

  it('handles redirect operators > and >>', () => {
    const result = parseCommand('echo test > /tmp/out.txt');
    expect(result.allPaths).toContain('/tmp/out.txt');
  });

  it('handles append redirect >>', () => {
    const result = parseCommand('echo test >> /tmp/log.txt');
    expect(result.allPaths).toContain('/tmp/log.txt');
  });

  it('handles input redirect <', () => {
    const result = parseCommand('sort < /tmp/input.txt');
    expect(result.allPaths).toContain('/tmp/input.txt');
  });

  it('extracts paths from cd commands', () => {
    const result = parseCommand('cd /home/user && ls');
    expect(result.allPaths).toContain('/home/user');
  });

  it('returns empty for empty string', () => {
    const result = parseCommand('');
    expect(result.commands).toHaveLength(0);
    expect(result.allBinaries).toHaveLength(0);
    expect(result.allPaths).toHaveLength(0);
    expect(result.raw).toBe('');
  });

  it('returns empty for whitespace-only string', () => {
    const result = parseCommand('   ');
    expect(result.commands).toHaveLength(0);
  });

  it('handles commands with flags', () => {
    const result = parseCommand('npm install --save-dev typescript');
    expect(result.commands[0].binary).toBe('npm');
    expect(result.commands[0].args).toEqual(['install', '--save-dev', 'typescript']);
  });

  it('handles relative paths starting with .', () => {
    const result = parseCommand('cat ./src/index.ts');
    expect(result.allPaths).toContain('./src/index.ts');
  });

  it('handles || operator', () => {
    const result = parseCommand('test -f /tmp/x || echo missing');
    expect(result.commands).toHaveLength(2);
    expect(result.allBinaries).toEqual(['test', 'echo']);
  });

  it('handles subshell $(..)', () => {
    const result = parseCommand('echo $(cat /tmp/data.txt)');
    expect(result.allPaths).toContain('/tmp/data.txt');
  });

  it('extracts paths with file extensions', () => {
    const result = parseCommand('node script.js');
    expect(result.allPaths).toContain('script.js');
  });
});
