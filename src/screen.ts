import { Terminal } from '@xterm/headless';

export function awaitWrite(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

export interface ReadScreenOptions {
  startRow?: number;
  endRow?: number;
  trimWhitespace?: boolean;
  includeEmpty?: boolean;
}

export function readScreen(terminal: Terminal, options?: ReadScreenOptions): string {
  const buffer = terminal.buffer.active;
  const viewportStart = buffer.viewportY;
  const startRow = Math.max(0, Math.min(options?.startRow ?? 0, terminal.rows));
  const endRow = Math.max(0, Math.min(options?.endRow ?? terminal.rows, terminal.rows));
  const trim = options?.trimWhitespace ?? false;

  const lines: string[] = [];
  for (let y = startRow; y < endRow; y++) {
    const line = buffer.getLine(viewportStart + y);
    lines.push(line?.translateToString(trim) ?? '');
  }

  if (options?.includeEmpty === false) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
  }

  return lines.join('\n');
}

export interface ScreenRegion {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export function validateRegion(
  terminal: Terminal,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): ScreenRegion {
  if (endRow < startRow) {
    throw new Error(`endRow (${endRow}) must be >= startRow (${startRow})`);
  }
  if (endCol < startCol) {
    throw new Error(`endCol (${endCol}) must be >= startCol (${startCol})`);
  }
  return {
    startRow: Math.max(0, Math.min(startRow, terminal.rows)),
    startCol: Math.max(0, Math.min(startCol, terminal.cols)),
    endRow: Math.max(0, Math.min(endRow, terminal.rows)),
    endCol: Math.max(0, Math.min(endCol, terminal.cols)),
  };
}

export function readScreenRegion(
  terminal: Terminal,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number
): string {
  const region = validateRegion(terminal, startRow, startCol, endRow, endCol);
  const buffer = terminal.buffer.active;
  const viewportStart = buffer.viewportY;
  const lines: string[] = [];

  for (let y = region.startRow; y < region.endRow; y++) {
    const line = buffer.getLine(viewportStart + y);
    lines.push(line?.translateToString(false, region.startCol, region.endCol) ?? '');
  }

  return lines.join('\n');
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const MAX_COLS = 500;
const MAX_ROWS = 200;

export function clampDimensions(cols?: number, rows?: number): { cols: number; rows: number } {
  const isValidDimension = (n: number) => Number.isInteger(n) && n >= 1;

  return {
    cols: typeof cols === 'number' && isValidDimension(cols) ? Math.min(cols, MAX_COLS) : DEFAULT_COLS,
    rows: typeof rows === 'number' && isValidDimension(rows) ? Math.min(rows, MAX_ROWS) : DEFAULT_ROWS,
  };
}
