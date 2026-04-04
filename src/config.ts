export const SESSION_TIMEOUT_MS = 600_000;
export const MAX_WAIT_MS = 5000;
export const MAX_COLS = 500;
export const MAX_ROWS = 200;
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 40;
export const ALLOWED_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'powershell.exe', 'pwsh', 'cmd.exe']);

export function selectShell(shell?: string): string {
  return shell && ALLOWED_SHELLS.has(shell)
    ? shell
    : (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash'));
}

export function isValidDimension(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}
