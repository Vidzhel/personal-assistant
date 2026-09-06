import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { updateTicktickSettings, validateTicktickToken } from './ticktick-settings.mjs';

const roots = [];
function fixture(content = 'OWNER_SETTING=preserved\n') {
  const root = mkdtempSync(join(tmpdir(), 'raven-ticktick-settings-'));
  roots.push(root);
  const envFile = join(root, '.env');
  writeFileSync(envFile, content);
  return { root, envFile };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('updates only the dedicated token and preserves mode and unrelated bytes', () => {
  const { envFile } = fixture("OWNER_SETTING='value with spaces'\r\nTICKTICK_MCP_TOKEN=old\r\n");
  chmodSync(envFile, 0o640);
  let candidate = '';
  updateTicktickSettings({
    envFile,
    token: "new-$token-'value",
    validateCandidate: (path) => {
      candidate = readFileSync(path, 'utf8');
    },
  });
  const expected = "OWNER_SETTING='value with spaces'\r\nTICKTICK_MCP_TOKEN='new-$token-\\'value'\r\n";
  assert.equal(candidate, expected);
  assert.equal(readFileSync(envFile, 'utf8'), expected);
  assert.equal(lstatSync(envFile).mode & 0o777, 0o640);
});

test('rejects control characters, empty input, oversized input, and duplicate settings', () => {
  for (const token of ['', '   ', ' surrounding', 'trailing ', 'line\nbreak', 'tab\tvalue', 'x'.repeat(4097)]) {
    assert.throws(() => validateTicktickToken(token), /1-4096 characters, non-blank/);
  }
  const { envFile } = fixture('TICKTICK_MCP_TOKEN=one\nTICKTICK_MCP_TOKEN=two\n');
  const before = readFileSync(envFile, 'utf8');
  assert.throws(
    () => updateTicktickSettings({ envFile, token: 'valid-token' }),
    /assigned more than once/,
  );
  assert.equal(readFileSync(envFile, 'utf8'), before);
});

test('validation failure and concurrent edits never overwrite the original file', () => {
  const first = fixture();
  const before = readFileSync(first.envFile, 'utf8');
  assert.throws(
    () =>
      updateTicktickSettings({
        envFile: first.envFile,
        token: 'valid-token',
        validateCandidate: () => {
          throw new Error('invalid candidate');
        },
      }),
    /invalid candidate/,
  );
  assert.equal(readFileSync(first.envFile, 'utf8'), before);

  const second = fixture();
  assert.throws(
    () =>
      updateTicktickSettings({
        envFile: second.envFile,
        token: 'valid-token',
        validateCandidate: () => writeFileSync(second.envFile, 'CONCURRENT=edit\n'),
      }),
    /changed during validation/,
  );
  assert.equal(readFileSync(second.envFile, 'utf8'), 'CONCURRENT=edit\n');
});

test('rejects symlinked and oversized environment files', () => {
  const { root, envFile } = fixture();
  const link = join(root, 'linked.env');
  symlinkSync(envFile, link);
  assert.throws(
    () => updateTicktickSettings({ envFile: link, token: 'valid-token' }),
    /not a symlink/,
  );
  writeFileSync(envFile, 'x'.repeat(256 * 1024 + 1));
  assert.throws(
    () => updateTicktickSettings({ envFile, token: 'valid-token' }),
    /too large/,
  );
});
