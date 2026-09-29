//! Finds the IDs under which course2md is loaded in the local Chromium browsers, so the
//! native messaging host can be registered for the real IDs instead of a hardcoded guess.
//! An unpacked extension's ID is derived from its folder path: every checkout, and every
//! folder a release zip is extracted to, gets a different ID.

import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** User-data roots of the browsers the installer registers the host for. */
export function browserProfileRoots() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return ['Microsoft/Edge', 'Google/Chrome', 'Chromium'].map((name) => path.join(local, ...name.split('/'), 'User Data'));
  }
  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return ['Microsoft Edge', 'Google/Chrome', 'Chromium'].map((name) => path.join(support, ...name.split('/')));
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['microsoft-edge', 'google-chrome', 'chromium'].map((name) => path.join(config, name));
}

/**
 * IDs of every loaded copy of course2md across all profiles. An entry counts only when the
 * folder it points to holds our manifest, so similarly named extensions are never trusted.
 */
export function detectExtensionIds(roots = browserProfileRoots()) {
  const ids = new Set();
  for (const root of roots) {
    let profiles;
    try {
      profiles = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue; // browser not installed
    }
    for (const profile of profiles) {
      for (const file of ['Secure Preferences', 'Preferences']) {
        let settings;
        try {
          settings = JSON.parse(readFileSync(path.join(root, profile, file), 'utf8'))?.extensions?.settings;
        } catch {
          continue;
        }
        for (const [id, entry] of Object.entries(settings ?? {})) {
          if (!/^[a-p]{32}$/.test(id) || typeof entry?.path !== 'string') continue;
          // Unpacked extensions record an absolute folder; store installs a path under the profile.
          const folder = path.isAbsolute(entry.path) ? entry.path : path.join(root, profile, 'Extensions', entry.path);
          if (isCourse2md(folder)) ids.add(id);
        }
      }
    }
  }
  return [...ids];
}

function isCourse2md(folder) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    return String(manifest.name ?? '').startsWith('course2md') && manifest.background?.service_worker === 'src/background/sw.js';
  } catch {
    return false;
  }
}
