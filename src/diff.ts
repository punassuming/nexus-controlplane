import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);
const MAX = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 50;
const MAX_UNTRACKED_BYTES = 64 * 1024;

export interface UntrackedFile {
  path: string;
  /** First bytes of a text file; absent for binary or over the budget. */
  content?: string;
  binary?: boolean;
}

export interface DiffResult {
  cwd: string;
  status: string;
  diff: string;
  untracked: UntrackedFile[];
  truncated: boolean;
}

/**
 * Read-only git inspection, out-of-band from Nexus. Only runs fixed git subcommands and never writes
 * the index (no optional locks). New files an agent created are listed with a preview, since
 * `git diff` alone doesn't show them.
 */
export async function gitDiff(cwd: string): Promise<DiffResult> {
  if (!(await stat(cwd).then((s) => s.isDirectory(), () => false))) throw new Error('cwd not found');
  const git = (args: string[]) =>
    run('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
      cwd, maxBuffer: MAX * 2, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).then((r) => r.stdout);

  const hasHead = await git(['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false);
  const [status, diff, others] = await Promise.all([
    git(['status', '--porcelain=v1', '--branch']),
    // A repo with no commits has no HEAD: show staged plus unstaged changes instead.
    hasHead
      ? git(['diff', '--no-ext-diff', 'HEAD'])
      : Promise.all([git(['diff', '--no-ext-diff', '--cached']), git(['diff', '--no-ext-diff'])]).then((d) => d.join('')),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);

  let budget = MAX_UNTRACKED_BYTES;
  const paths = others.split('\0').filter(Boolean);
  const untracked: UntrackedFile[] = [];
  for (const path of paths.slice(0, MAX_UNTRACKED_FILES)) {
    const f: UntrackedFile = { path };
    if (budget > 0) {
      const fh = await open(join(cwd, path), 'r').catch(() => undefined);
      if (fh) {
        const buf = Buffer.alloc(Math.min(budget, 16 * 1024));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        await fh.close();
        const bytes = buf.subarray(0, bytesRead);
        if (bytes.includes(0)) f.binary = true;
        else { f.content = bytes.toString('utf8'); budget -= bytesRead; }
      }
    }
    untracked.push(f);
  }
  return {
    cwd, status, diff: diff.slice(0, MAX), untracked,
    truncated: diff.length > MAX || paths.length > MAX_UNTRACKED_FILES,
  };
}
