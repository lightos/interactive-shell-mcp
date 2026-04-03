import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as pty from 'node-pty';
import { Terminal } from '@xterm/headless';
// Additional screen imports will be added in Task 9

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
