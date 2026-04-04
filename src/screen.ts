import { Terminal } from '@xterm/headless';
import { DEFAULT_COLS, DEFAULT_ROWS, MAX_COLS, MAX_ROWS, isValidDimension } from './config';

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
  endCol: number,
  trimWhitespace?: boolean
): string {
  const region = validateRegion(terminal, startRow, startCol, endRow, endCol);
  const buffer = terminal.buffer.active;
  const viewportStart = buffer.viewportY;
  const lines: string[] = [];

  for (let y = region.startRow; y < region.endRow; y++) {
    const line = buffer.getLine(viewportStart + y);
    lines.push(line?.translateToString(trimWhitespace ?? false, region.startCol, region.endCol) ?? '');
  }

  return lines.join('\n');
}

export interface SearchResult {
  row: number;
  col: number;
  text: string;
}

const MAX_SEARCH_RESULTS = 50;
const MAX_PATTERN_LENGTH = 200;

export function searchScreen(terminal: Terminal, pattern: string, isRegex?: boolean): SearchResult[] {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`Pattern too long: max ${MAX_PATTERN_LENGTH} characters`);
  }

  const buffer = terminal.buffer.active;
  const viewportStart = buffer.viewportY;
  const results: SearchResult[] = [];

  let regex: RegExp | null = null;
  if (isRegex) {
    try {
      regex = new RegExp(pattern, 'g');
    } catch (e) {
      throw new Error(`Invalid regex pattern: ${pattern}`);
    }
  }

  for (let y = 0; y < terminal.rows && results.length < MAX_SEARCH_RESULTS; y++) {
    const line = buffer.getLine(viewportStart + y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (regex) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null && results.length < MAX_SEARCH_RESULTS) {
        results.push({ row: y, col: match.index, text: match[0] });
      }
    } else {
      let startIdx = 0;
      let idx;
      while ((idx = text.indexOf(pattern, startIdx)) !== -1 && results.length < MAX_SEARCH_RESULTS) {
        results.push({ row: y, col: idx, text: pattern });
        startIdx = idx + 1;
      }
    }
  }
  return results;
}

export function clampDimensions(cols?: number, rows?: number): { cols: number; rows: number } {
  return {
    cols: typeof cols === 'number' && isValidDimension(cols) ? Math.min(cols, MAX_COLS) : DEFAULT_COLS,
    rows: typeof rows === 'number' && isValidDimension(rows) ? Math.min(rows, MAX_ROWS) : DEFAULT_ROWS,
  };
}
