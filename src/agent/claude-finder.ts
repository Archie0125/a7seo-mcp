import { spawnSync } from 'child_process';

let cachedPath: string | null | undefined;

export function findClaudePath(): string | null {
  if (cachedPath !== undefined) return cachedPath;

  // Try direct exe paths first (avoids shell: true issues on Windows)
  if (process.platform === 'win32') {
    const home = (process.env.USERPROFILE || '').replace(/\\/g, '/');
    const candidates = [
      `${home}/.local/bin/claude.exe`,
      `${(process.env.LOCALAPPDATA || '').replace(/\\/g, '/')}/Programs/claude/claude.exe`,
    ];
    for (const cmd of candidates) {
      try {
        const result = spawnSync(cmd, ['--version'], {
          encoding: 'utf-8',
          timeout: 5000,
        });
        if (result.status === 0) {
          cachedPath = cmd;
          return cachedPath;
        }
      } catch {
        // continue
      }
    }
  }

  // Fallback: bare 'claude' with shell
  try {
    const result = spawnSync('claude', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      shell: true,
    });
    if (result.status === 0) {
      cachedPath = 'claude';
      return cachedPath;
    }
  } catch {
    // not found
  }

  cachedPath = null;
  return null;
}
