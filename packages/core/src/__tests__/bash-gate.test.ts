import { describe, it, expect } from 'vitest';
import { checkBashAccess, globMatch } from '../bash-gate/bash-gate.ts';
import type { BashAccess } from '@raven/shared';

function makeConfig(overrides: Partial<BashAccess> = {}): BashAccess {
  return {
    access: 'none',
    allowedCommands: [],
    deniedCommands: [],
    allowedPaths: [],
    deniedPaths: [],
    ...overrides,
  };
}

describe('globMatch', () => {
  it('matches exact strings', () => {
    expect(globMatch('.env', '.env')).toBe(true);
    expect(globMatch('.env', '.envx')).toBe(false);
  });

  it('* matches anything except /', () => {
    expect(globMatch('*.ts', 'file.ts')).toBe(true);
    expect(globMatch('*.ts', 'dir/file.ts')).toBe(false);
  });

  it('** matches anything including /', () => {
    expect(globMatch('.git/**', '.git/config')).toBe(true);
    expect(globMatch('.git/**', '.git/refs/heads/main')).toBe(true);
    expect(globMatch('data/**', 'data/logs/raven.log')).toBe(true);
  });
});

describe('access: none', () => {
  it('blocks all commands', () => {
    const config = makeConfig({ access: 'none' });
    const result = checkBashAccess('ls', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('none');
  });
});

describe('access: sandboxed', () => {
  it('allows whitelisted commands', () => {
    const config = makeConfig({
      access: 'sandboxed',
      allowedCommands: ['ls', 'cat', 'echo'],
    });
    expect(checkBashAccess('ls /tmp', config).allowed).toBe(true);
    expect(checkBashAccess('cat file.txt', config).allowed).toBe(true);
  });

  it('blocks non-whitelisted commands', () => {
    const config = makeConfig({
      access: 'sandboxed',
      allowedCommands: ['ls', 'cat'],
    });
    const result = checkBashAccess('rm file.txt', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('rm');
  });

  it('blocks commands targeting disallowed paths', () => {
    const config = makeConfig({
      access: 'sandboxed',
      allowedCommands: ['cat'],
      allowedPaths: ['data/**'],
    });
    const result = checkBashAccess('cat /etc/passwd', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('/etc/passwd');
  });

  it('allows commands targeting allowed paths', () => {
    const config = makeConfig({
      access: 'sandboxed',
      allowedCommands: ['cat'],
      allowedPaths: ['data/**'],
    });
    expect(checkBashAccess('cat data/logs/out.txt', config).allowed).toBe(true);
  });

  it('deniedCommands overrides allowedCommands', () => {
    const config = makeConfig({
      access: 'sandboxed',
      allowedCommands: ['*'],
      deniedCommands: ['rm'],
    });
    expect(checkBashAccess('ls /tmp', config).allowed).toBe(true);
    const result = checkBashAccess('rm file.txt', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('denied');
  });
});

describe('access: scoped', () => {
  it('allows any command within allowed paths', () => {
    const config = makeConfig({
      access: 'scoped',
      allowedPaths: ['data/**', '/tmp/**'],
    });
    expect(checkBashAccess('cat data/log.txt', config).allowed).toBe(true);
    expect(checkBashAccess('rm /tmp/file.txt', config).allowed).toBe(true);
  });

  it('blocks commands targeting denied paths', () => {
    const config = makeConfig({
      access: 'scoped',
      deniedPaths: ['/etc/**'],
    });
    const result = checkBashAccess('cat /etc/passwd', config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('/etc/passwd');
  });

  it('allows commands with no file args', () => {
    const config = makeConfig({
      access: 'scoped',
      allowedPaths: ['data/**'],
    });
    expect(checkBashAccess('echo hello', config).allowed).toBe(true);
  });
});

describe('access: full', () => {
  it('allows most commands', () => {
    const config = makeConfig({ access: 'full' });
    expect(checkBashAccess('rm -rf /tmp/stuff', config).allowed).toBe(true);
    expect(checkBashAccess('curl https://example.com', config).allowed).toBe(true);
  });

  it('still blocks mandatory denies', () => {
    const config = makeConfig({ access: 'full' });
    expect(checkBashAccess('cat .env', config).allowed).toBe(false);
    expect(checkBashAccess('cat .git/config', config).allowed).toBe(false);
  });
});

describe('mandatory denies', () => {
  const fullConfig = makeConfig({ access: 'full' });
  const scopedConfig = makeConfig({ access: 'scoped' });
  const sandboxedConfig = makeConfig({
    access: 'sandboxed',
    allowedCommands: ['*'],
  });

  it('blocks .env access regardless of config', () => {
    for (const config of [fullConfig, scopedConfig, sandboxedConfig]) {
      const result = checkBashAccess('cat .env', config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.env');
    }
  });

  it('blocks .git/ access regardless of config', () => {
    for (const config of [fullConfig, scopedConfig, sandboxedConfig]) {
      const result = checkBashAccess('cat .git/config', config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('.git');
    }
  });

  it('blocks rm -rf / regardless of config', () => {
    for (const config of [fullConfig, scopedConfig, sandboxedConfig]) {
      const result = checkBashAccess('rm -rf /', config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('rm -rf /');
    }
  });
});
