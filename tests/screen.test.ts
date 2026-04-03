import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Terminal } from '@xterm/headless';
import { readScreen, readScreenRegion, awaitWrite, clampDimensions, validateRegion } from '../src/screen.js';

describe('readScreen', () => {
  it('returns rendered text from terminal buffer', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    await awaitWrite(terminal, 'hello world\r\n');
    const output = readScreen(terminal, { includeEmpty: false });
    assert.ok(output.includes('hello world'));
    terminal.dispose();
  });

  it('extracts specific row range', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    await awaitWrite(terminal, 'line0\r\nline1\r\nline2\r\nline3\r\n');
    const output = readScreen(terminal, { startRow: 1, endRow: 3, includeEmpty: false });
    const lines = output.split('\n');
    assert.ok(lines[0].includes('line1'));
    assert.ok(lines[1].includes('line2'));
    terminal.dispose();
  });
});

describe('cursor position', () => {
  it('tracks cursor position after writes', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await awaitWrite(terminal, 'abc');
    const buf = terminal.buffer.active;
    assert.strictEqual(buf.cursorX, 3);
    assert.strictEqual(buf.cursorY, 0);
    terminal.dispose();
  });

  it('tracks cursor on new line', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await awaitWrite(terminal, 'line1\r\nline2');
    const buf = terminal.buffer.active;
    assert.strictEqual(buf.cursorY, 1);
    assert.strictEqual(buf.cursorX, 5);
    terminal.dispose();
  });
});

describe('readScreenRegion', () => {
  it('extracts a rectangular region', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    await awaitWrite(terminal, 'ABCDEFGHIJ\r\n');
    await awaitWrite(terminal, 'KLMNOPQRST\r\n');
    await awaitWrite(terminal, 'UVWXYZ0123\r\n');

    const region = readScreenRegion(terminal, 0, 2, 2, 6);
    const lines = region.split('\n');
    assert.strictEqual(lines[0], 'CDEF');
    assert.strictEqual(lines[1], 'MNOP');
    terminal.dispose();
  });
});

describe('geometry preservation', () => {
  it('preserves row count when includeEmpty is not set', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    await awaitWrite(terminal, 'hello\r\n');
    const output = readScreen(terminal);
    const lines = output.split('\n');
    assert.strictEqual(lines.length, 5);
    terminal.dispose();
  });

  it('strips trailing empty lines when includeEmpty is false', async () => {
    const terminal = new Terminal({ cols: 20, rows: 10, allowProposedApi: true });
    await awaitWrite(terminal, 'line1\r\nline2\r\n');
    const output = readScreen(terminal, { includeEmpty: false });
    const lines = output.split('\n');
    assert.ok(lines.length < 10);
    assert.ok(lines.length >= 2);
    terminal.dispose();
  });

  it('preserves column width with trimWhitespace false', async () => {
    const terminal = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });
    await awaitWrite(terminal, 'hi\r\n');
    const output = readScreen(terminal, { trimWhitespace: false });
    const firstLine = output.split('\n')[0];
    assert.strictEqual(firstLine.length, 10);
    terminal.dispose();
  });
});

describe('alternate buffer detection', () => {
  it('detects alternate buffer entry and exit', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    assert.notStrictEqual(terminal.buffer.active, terminal.buffer.alternate);
    await awaitWrite(terminal, '\x1b[?1049h');
    assert.strictEqual(terminal.buffer.active, terminal.buffer.alternate);
    await awaitWrite(terminal, '\x1b[?1049l');
    assert.notStrictEqual(terminal.buffer.active, terminal.buffer.alternate);
    terminal.dispose();
  });
});

describe('clampDimensions', () => {
  it('returns defaults for undefined', () => {
    assert.deepStrictEqual(clampDimensions(), { cols: 120, rows: 40 });
  });
  it('clamps oversized values', () => {
    assert.deepStrictEqual(clampDimensions(1000, 500), { cols: 500, rows: 200 });
  });
  it('returns defaults for invalid values', () => {
    assert.deepStrictEqual(clampDimensions(-1, 0), { cols: 120, rows: 40 });
    assert.deepStrictEqual(clampDimensions(1.5, 2.7), { cols: 120, rows: 40 });
  });
  it('passes through valid values', () => {
    assert.deepStrictEqual(clampDimensions(80, 24), { cols: 80, rows: 24 });
  });
});

describe('validateRegion', () => {
  it('clamps coordinates to terminal bounds', () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const result = validateRegion(terminal, -5, -3, 100, 200);
    assert.strictEqual(result.startRow, 0);
    assert.strictEqual(result.startCol, 0);
    assert.strictEqual(result.endRow, 24);
    assert.strictEqual(result.endCol, 80);
    terminal.dispose();
  });
  it('throws when endRow < startRow', () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    assert.throws(() => validateRegion(terminal, 10, 0, 5, 80), /endRow.*must be >= startRow/);
    terminal.dispose();
  });
  it('throws when endCol < startCol', () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    assert.throws(() => validateRegion(terminal, 0, 50, 10, 20), /endCol.*must be >= startCol/);
    terminal.dispose();
  });
  it('passes through valid coordinates unchanged', () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const result = validateRegion(terminal, 2, 5, 10, 40);
    assert.deepStrictEqual(result, { startRow: 2, startCol: 5, endRow: 10, endCol: 40 });
    terminal.dispose();
  });
});

describe('awaitWrite', () => {
  it('ensures data is available after await', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await awaitWrite(terminal, 'test data');
    const line = terminal.buffer.active.getLine(0);
    assert.ok(line);
    const text = line.translateToString(true);
    assert.ok(text.includes('test data'));
    terminal.dispose();
  });
});
