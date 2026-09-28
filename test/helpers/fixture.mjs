/**
 * Verification harness: build a git repository with a known, awkward history,
 * then assert that oc's stream parser sees exactly what git sees.
 *
 * The fixture deliberately includes the cases that break naive parsers:
 * merge commits, empty commits, renames, binary files, paths with spaces and
 * non-ASCII characters, and files deleted later.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/**
 * @param {(git: (args: string[]) => Promise<string>) => Promise<void>} script
 * @returns {Promise<{dir: string, cleanup: () => Promise<void>}>}
 */
/**
 * Scratch directory for throwaway fixture repositories.
 *
 * Kept inside the project (and gitignored) rather than in the OS temp
 * directory, so that running the test suite touches nothing outside this folder.
 */
const SCRATCH = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '.tmp', 'fixtures');

export async function makeFixture(script) {
  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH, 'fx-'));
  const git = async (args) => {
    const { stdout } = await exec('git', args, { cwd: dir, env: ENV });
    return stdout;
  };
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.com']);
  await git(['config', 'commit.gpgsign', 'false']);
  await script(git, dir);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function write(dir, rel, content) {
  const full = join(dir, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

/** Every commit hash git itself reports, newest first. */
export async function gitLogHashes(dir) {
  const { stdout } = await exec('git', ['log', '--all', '--pretty=format:%H'], { cwd: dir, env: ENV });
  return stdout.trim().split('\n').filter(Boolean);
}

/**
 * Per-commit file lists straight from git, for differential testing.
 * Uses byte-for-byte the same format the adapter asks git for, so any
 * disagreement is a parser bug rather than a format difference.
 */
export async function gitLogNames(dir) {
  const { stdout } = await exec(
    'git',
    [
      'log', '--all', '--name-only', '--date=short', '-z', '--no-renames',
      '--pretty=format:%x01%H%x02%an%x02%ae%x02%ad%x02%P%x02%s',
    ],
    { cwd: dir, env: ENV, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Ground truth for "which files did this commit touch", obtained one commit at
 * a time. Deliberately shares no framing logic with the adapter, so it is a
 * real independent oracle rather than a reimplementation of the same parser.
 */
export async function gitShowNames(dir, hash) {
  const { stdout } = await exec(
    'git',
    ['show', '--pretty=format:', '--name-only', '--no-renames', '-z', hash],
    { cwd: dir, env: ENV, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split('\0').filter(Boolean).sort();
}
