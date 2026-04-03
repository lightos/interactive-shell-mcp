import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
import { readScreen, readScreenRegion, awaitWrite } from '../src/screen';

describe('session lifecycle integration', () => {
  it('xterm terminal receives PTY output', async () => {
    const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const ptyProcess = pty.spawn(shell, ['-c', 'echo "integration test"'], {
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: process.env,
    });

    const done = new Promise<void>((resolve) => {
      ptyProcess.onData((data) => {
        terminal.write(data, () => {});
      });
      ptyProcess.onExit(() => {
        setTimeout(resolve, 200);
      });
    });

    await done;

    let found = false;
    const buf = terminal.buffer.active;
    for (let y = 0; y < terminal.rows; y++) {
      const line = buf.getLine(y);
      if (line && line.translateToString(true).includes('integration test')) {
        found = true;
        break;
      }
    }
    assert.ok(found, 'Expected "integration test" in terminal screen');
    terminal.dispose();
  });
});

describe('screen mode with PTY', () => {
  it('reads rendered output from echo command', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const ptyProcess = pty.spawn(shell, ['-c', 'echo "screen test output"'], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });

    await new Promise<void>((resolve) => {
      ptyProcess.onData((data) => {
        terminal.write(data, () => {});
      });
      ptyProcess.onExit(() => setTimeout(resolve, 200));
    });

    const screen = readScreen(terminal, { includeEmpty: false, trimWhitespace: true });
    assert.ok(
      screen.includes('screen test output'),
      `Expected "screen test output" in:\n${screen}`
    );
    terminal.dispose();
  });
});

describe('alternate buffer with PTY', () => {
  it('detects alternate buffer entry and exit via raw ANSI', async () => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });

    let writePromise = Promise.resolve();
    ptyProcess.onData((data) => {
      writePromise = awaitWrite(terminal, data);
    });

    await new Promise((r) => setTimeout(r, 500));

    ptyProcess.write('printf "\\x1b[?1049h"\r');
    await new Promise((r) => setTimeout(r, 300));
    await writePromise;

    assert.strictEqual(
      terminal.buffer.active === terminal.buffer.alternate,
      true,
      'Should be in alternate buffer'
    );

    ptyProcess.write('printf "\\x1b[?1049l"\r');
    await new Promise((r) => setTimeout(r, 300));
    await writePromise;

    assert.strictEqual(
      terminal.buffer.active === terminal.buffer.alternate,
      false,
      'Should be back in normal buffer'
    );

    ptyProcess.kill();
    terminal.dispose();
  });
});

describe('region extraction with PTY', () => {
  it('extracts specific region from command output', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const ptyProcess = pty.spawn(shell, ['-c', 'printf "AAAA\\nBBBB\\nCCCC\\n"'], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });

    await new Promise<void>((resolve) => {
      ptyProcess.onData((data) => {
        terminal.write(data, () => {});
      });
      ptyProcess.onExit(() => setTimeout(resolve, 200));
    });

    let bbbbRow = -1;
    const buf = terminal.buffer.active;
    for (let y = 0; y < terminal.rows; y++) {
      const line = buf.getLine(y);
      if (line && line.translateToString(true).includes('BBBB')) {
        bbbbRow = y;
        break;
      }
    }
    assert.ok(bbbbRow >= 0, 'Could not find BBBB row');

    const region = readScreenRegion(terminal, bbbbRow, 0, bbbbRow + 1, 4);
    assert.strictEqual(region, 'BBBB');
    terminal.dispose();
  });
});
