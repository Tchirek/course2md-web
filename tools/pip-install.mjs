// Running pip for the local runtimes, robust against a flaky package index.
//
// Mirrors can be slow and occasionally serve a truncated file: pip then rejects it (the hash from the
// index does not match) and the whole install fails. An install is retried, and the retry goes to
// the official index (pypi.org) in case the configured mirror is the problem.
import { spawn } from 'node:child_process';

export const OFFICIAL_INDEX = 'https://pypi.org/simple';

/** Runs a command; resolves with its exit code and the tail of its output. Output lines go to onLine. */
export function run(command, args, { env, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const take = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-2000);
      for (const line of text.split(/\r?\n|\r/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, tail }));
  });
}

/**
 * pip install with retries: the configured index, then the official one, then the configured one again.
 * @param {string} python
 * @param {string[]} args arguments after "pip install"
 * @param {{ env?: NodeJS.ProcessEnv, onLine?: (line: string) => void, onRetry?: (attempt: number) => void }} [options]
 */
export async function pipInstall(python, args, { env, onLine, onRetry = () => {} } = {}) {
  const attempts = [[], ['--index-url', OFFICIAL_INDEX], []];
  let result;
  for (const [index, extra] of attempts.entries()) {
    if (index) onRetry(index);
    result = await run(python, ['-m', 'pip', 'install', '--no-cache-dir', '--retries', '5', '--timeout', '60', ...extra, ...args], { env, onLine });
    if (result.code === 0) return result;
  }
  return result;
}
