import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { clampDimensions } from '../src/screen.js';

// Duplicate allowlist here — cannot import from server.ts because it starts the MCP server at module level
const ALLOWED_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'powershell.exe', 'pwsh', 'cmd.exe']);

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
