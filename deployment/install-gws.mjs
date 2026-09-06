import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

const VERSION = '0.22.5';
const RELEASE_ROOT = `https://github.com/googleworkspace/cli/releases/download/v${VERSION}`;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

const ARTIFACTS = {
  x64: {
    archive: 'google-workspace-cli-x86_64-unknown-linux-musl.tar.gz',
    sha256: '4db473dde4b1ab872e4ff35d769b0d4af1f1a6441a605e79d5cf8ada9c87e920',
  },
  arm64: {
    archive: 'google-workspace-cli-aarch64-unknown-linux-musl.tar.gz',
    sha256: 'e700fe63524932b10ec2130b47ece90aa850e66005fe52ccfc4cf8767bf9919a',
  },
};

function fail(message) {
  throw new Error(message);
}

function installationDirectory(value) {
  if (!value || !isAbsolute(value)) {
    fail('Usage: node deployment/install-gws.mjs /absolute/install/directory');
  }
  const inputStat = lstatSync(value);
  if (!inputStat.isDirectory() || inputStat.isSymbolicLink()) {
    fail(`gws install target must be a real directory: ${value}`);
  }
  const path = realpathSync(value);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`gws install target must be a real directory: ${value}`);
  }
  return path;
}

function selectedArtifact() {
  if (process.platform !== 'linux') {
    fail(`Unsupported gws install platform: ${process.platform}`);
  }
  const artifact = ARTIFACTS[process.arch];
  if (!artifact) fail(`Unsupported gws install architecture: ${process.arch}`);
  return artifact;
}

async function download(url, path, expectedHash) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    fail(`Could not download gws release archive: HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    fail('gws release archive exceeds the download limit');
  }

  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_ARCHIVE_BYTES) fail('gws release archive exceeds the download limit');
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = writeSync(descriptor, chunk, offset, chunk.byteLength - offset);
        if (written === 0) fail('Could not write gws release archive');
        offset += written;
      }
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (bytes === 0) fail('gws release archive is empty');
  const actualHash = digest.digest('hex');
  if (actualHash !== expectedHash) fail('gws release archive checksum did not match');
}

function archiveBinaryMember(archivePath) {
  const listing = execFileSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  });
  const members = listing.split('\n').filter(Boolean);
  const binaryMembers = members.filter((member) => member.replace(/^(?:\.\/)+/, '') === 'gws');
  if (binaryMembers.length !== 1) {
    fail('gws release archive must contain exactly one top-level gws entry');
  }
  return binaryMembers[0];
}

function extractBinary(archivePath, member, targetPath) {
  const descriptor = openSync(
    targetPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o700,
  );
  let result;
  try {
    result = spawnSync('tar', ['-xOf', archivePath, member], {
      stdio: ['ignore', descriptor, 'pipe'],
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (result.error || result.status !== 0) fail('Could not extract gws from the release archive');
  const stat = lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    fail('Extracted gws executable is not a non-empty regular file');
  }
  chmodSync(targetPath, 0o755);
}

function verifyBinary(path) {
  const output = execFileSync(path, ['--version'], {
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  }).trim();
  const [versionLine] = output.split(/\r?\n/);
  if (versionLine !== `gws ${VERSION}`) {
    fail(`Installed gws reported an unexpected version: ${versionLine ?? '(empty)'}`);
  }
}

async function main() {
  if (process.argv.length !== 3) {
    fail('Usage: node deployment/install-gws.mjs /absolute/install/directory');
  }
  const installDir = installationDirectory(process.argv[2]);
  const artifact = selectedArtifact();
  const destination = join(installDir, 'gws');
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    fail(`Existing gws target must be a regular file: ${destination}`);
  }

  const temporaryDirectory = mkdtempSync(join(installDir, '.gws-install-'));
  try {
    const archivePath = join(temporaryDirectory, artifact.archive);
    const extractedPath = join(temporaryDirectory, 'gws');
    await download(`${RELEASE_ROOT}/${artifact.archive}`, archivePath, artifact.sha256);
    const member = archiveBinaryMember(archivePath);
    extractBinary(archivePath, member, extractedPath);
    verifyBinary(extractedPath);
    renameSync(extractedPath, destination);
    chmodSync(destination, 0o755);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(`Installed gws ${VERSION} for ${process.arch}`);
}

main().catch((error) => {
  console.error(
    `gws installation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
