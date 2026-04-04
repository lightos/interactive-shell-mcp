import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { clampDimensions } from '../src/screen.js';
import { ALLOWED_SHELLS, selectShell, SESSION_TIMEOUT_MS, MAX_WAIT_MS, DEFAULT_COLS, DEFAULT_ROWS, MAX_COLS, MAX_ROWS } from '../src/config.js';

describe('ALLOWED_SHELLS validation', () => {
  it('accepts valid shells', () => {
    assert.ok(ALLOWED_SHELLS.has('bash'));
    assert.ok(ALLOWED_SHELLS.has('zsh'));
    assert.ok(ALLOWED_SHELLS.has('fish'));
    assert.ok(ALLOWED_SHELLS.has('sh'));
    assert.ok(ALLOWED_SHELLS.has('powershell.exe'));
    assert.ok(ALLOWED_SHELLS.has('pwsh'));
    assert.ok(ALLOWED_SHELLS.has('cmd.exe'));
  });

  it('rejects invalid shells', () => {
    assert.ok(!ALLOWED_SHELLS.has('/bin/evil'));
    assert.ok(!ALLOWED_SHELLS.has('python'));
    assert.ok(!ALLOWED_SHELLS.has(''));
    assert.ok(!ALLOWED_SHELLS.has('bash; rm -rf /'));
  });
});

describe('resize validation', () => {
  it('rejects non-integer cols by defaulting to DEFAULT_COLS (120)', () => {
    assert.strictEqual(clampDimensions(1.5, 24).cols, 120);
    assert.strictEqual(clampDimensions(NaN, 24).cols, 120);
  });

  it('rejects non-positive values by defaulting to defaults', () => {
    assert.strictEqual(clampDimensions(0, 24).cols, 120);
    assert.strictEqual(clampDimensions(-1, 24).cols, 120);
    assert.strictEqual(clampDimensions(80, 0).rows, 40);
    assert.strictEqual(clampDimensions(80, -5).rows, 40);
  });

  it('clamps cols and rows to maximum', () => {
    assert.strictEqual(clampDimensions(1000, 24).cols, 500);
    assert.strictEqual(clampDimensions(80, 500).rows, 200);
  });

  it('leaves valid values unchanged', () => {
    assert.strictEqual(clampDimensions(80, 24).cols, 80);
    assert.strictEqual(clampDimensions(80, 24).rows, 24);
    assert.strictEqual(clampDimensions(120, 40).cols, 120);
    assert.strictEqual(clampDimensions(500, 200).cols, 500);
    assert.strictEqual(clampDimensions(500, 200).rows, 200);
  });
});

describe('selectShell', () => {
  it('returns allowed shell when provided', () => {
    assert.strictEqual(selectShell('bash'), 'bash');
    assert.strictEqual(selectShell('zsh'), 'zsh');
    assert.strictEqual(selectShell('fish'), 'fish');
  });

  it('returns platform default for invalid shell', () => {
    const result = selectShell('python');
    assert.ok(ALLOWED_SHELLS.has(result) || result === (process.env.SHELL || 'bash'));
  });

  it('returns platform default when no shell specified', () => {
    const result = selectShell();
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('returns platform default for undefined', () => {
    const result = selectShell(undefined);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });
});

describe('config constants', () => {
  it('exports SESSION_TIMEOUT_MS', () => {
    assert.strictEqual(SESSION_TIMEOUT_MS, 600_000);
  });

  it('exports MAX_WAIT_MS', () => {
    assert.strictEqual(MAX_WAIT_MS, 5000);
  });

  it('exports dimension constants', () => {
    assert.strictEqual(DEFAULT_COLS, 120);
    assert.strictEqual(DEFAULT_ROWS, 40);
    assert.strictEqual(MAX_COLS, 500);
    assert.strictEqual(MAX_ROWS, 200);
  });

  it('exports ALLOWED_SHELLS as a Set with expected entries', () => {
    assert.ok(ALLOWED_SHELLS instanceof Set);
    assert.strictEqual(ALLOWED_SHELLS.size, 9);
  });
});
