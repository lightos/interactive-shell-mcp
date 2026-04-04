#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import { Terminal } from '@xterm/headless';
import { readScreen, readScreenRegion, awaitWrite, clampDimensions, searchScreen } from './screen';
import { SESSION_TIMEOUT_MS, MAX_WAIT_MS, MAX_COLS, MAX_ROWS, selectShell } from './config';

const DEFAULT_MAX_BUFFER_SIZE = 1024 * 1024; // 1MB default limit
const SNAPSHOT_INTERVAL_MS = 100; // Minimum time between snapshots
const DEFAULT_SNAPSHOT_SIZE = 50000; // 50KB default snapshot size

interface ShellSession {
  id: string;
  shell: string;
  ptyProcess: pty.IPty;
  outputBuffer: string;
  lastSnapshot: string;
  lastSnapshotTime: number;
  totalBytesReceived: number;
  maxBufferSize: number;
  terminal: Terminal;
  lastWritePromise: Promise<void>;
  lastDataTime: number;
  lastActivityTime: number;
}

class InteractiveShellServer {
  private server: Server;
  private sessions: Map<string, ShellSession> = new Map();
  private recentlyExited: Map<string, { exitCode: number; signal?: number; exitedAt: number }> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'interactive-shell-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandling();

    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastActivityTime > SESSION_TIMEOUT_MS) {
          this.disposeSession(id);
        }
      }
      for (const [id, info] of this.recentlyExited) {
        if (now - info.exitedAt > 60_000) this.recentlyExited.delete(id);
      }
    }, 60_000);
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'start_shell_session',
          description: 'Spawns a new PTY shell with a virtual terminal emulator and returns a unique session ID',
          inputSchema: {
            type: 'object',
            properties: {
              cols: { type: 'number', description: 'Terminal columns (default: 120, max: 500)', default: 120 },
              rows: { type: 'number', description: 'Terminal rows (default: 40, max: 200)', default: 40 },
              shell: { type: 'string', description: 'Shell to use (bash, zsh, fish, sh, dash, ksh, powershell.exe, pwsh, cmd.exe). Defaults to platform shell.' },
              cwd: { type: 'string', description: 'Working directory for the shell (default: server process cwd)' },
            },
            required: [],
          },
        },
        {
          name: 'send_shell_input',
          description: 'Writes input to the PTY. By default appends a carriage return. Use raw mode for interactive prompts (arrow keys, space to toggle, etc.)',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: {
                type: 'string',
                description: 'The session ID of the shell',
              },
              input: {
                type: 'string',
                description: 'The input to send to the shell. In raw mode, use escape sequences like \\x1b[A (up), \\x1b[B (down), \\r (enter), space for toggle',
              },
              raw: {
                type: 'boolean',
                description: 'Send input without appending newline. Interprets escape sequences (\\x1b, \\r, \\n, \\t, \\e). Use for interactive selection prompts, arrow key navigation, etc.',
                default: false,
              },
            },
            required: ['sessionId', 'input'],
          },
        },
        {
          name: 'read_shell_output',
          description: 'Returns output from the PTY process. Supports three modes: streaming (default) returns buffered output since last read, snapshot mode returns current terminal state, screen mode returns the parsed virtual terminal screen',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: {
                type: 'string',
                description: 'The session ID of the shell',
              },
              mode: {
                type: 'string',
                enum: ['streaming', 'snapshot', 'screen'],
                description: 'Output mode: streaming (default) for regular commands, snapshot for continuously updating apps like top/htop/airodump-ng, screen for parsed terminal screen contents',
                default: 'streaming',
              },
              maxBytes: {
                type: 'number',
                description: 'Maximum bytes to return (default: 100KB, max: 1MB)',
                default: 102400,
              },
              snapshotSize: {
                type: 'number',
                description: 'Size of the snapshot buffer to capture (default: 50KB)',
                default: 50000,
              },
              rows: {
                type: 'number',
                description: 'Start row for screen mode (0-based, inclusive)',
              },
              rowEnd: {
                type: 'number',
                description: 'End row for screen mode (exclusive)',
              },
              includeEmpty: {
                type: 'boolean',
                description: 'Include empty trailing lines in screen mode output (default: true)',
                default: true,
              },
              trimWhitespace: {
                type: 'boolean',
                description: 'Trim trailing whitespace from each line in screen mode (default: false)',
                default: false,
              },
              waitForIdle: {
                type: 'number',
                description: 'Wait until PTY output is idle for this many ms before reading. Max effective wait is 5000ms even if output keeps arriving. (default: no wait)',
              },
            },
            required: ['sessionId'],
          },
        },
        {
          name: 'get_screen_region',
          description: 'Extracts text from a rectangular region of the terminal screen. Coordinates are 0-based, end values are exclusive.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'The session ID of the shell' },
              startRow: { type: 'number', description: 'Start row (0-based, inclusive)' },
              startCol: { type: 'number', description: 'Start column (0-based, inclusive)' },
              endRow: { type: 'number', description: 'End row (exclusive)' },
              endCol: { type: 'number', description: 'End column (exclusive)' },
              trimWhitespace: { type: 'boolean', description: 'Trim trailing whitespace from each line (default: false)', default: false },
              waitForIdle: { type: 'number', description: 'Wait until PTY output is idle for this many ms before reading. Max effective wait is 5000ms even if output keeps arriving. (default: no wait)' },
            },
            required: ['sessionId', 'startRow', 'startCol', 'endRow', 'endCol'],
          },
        },
        {
          name: 'get_screen_cursor',
          description: 'Returns the current cursor position and the text of the line the cursor is on. Lightweight alternative to reading the full screen.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'The session ID of the shell' },
              waitForIdle: { type: 'number', description: 'Wait until PTY output is idle for this many ms before reading. Max effective wait is 5000ms even if output keeps arriving. (default: no wait)' },
            },
            required: ['sessionId'],
          },
        },
        {
          name: 'search_screen',
          description: 'Search the terminal screen for text or regex pattern. Returns matching positions.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'The session ID of the shell' },
              pattern: { type: 'string', description: 'Text or regex pattern to search for' },
              regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default: false)', default: false },
              waitForIdle: { type: 'number', description: 'Wait until PTY output is idle for this many ms before reading. Max effective wait is 5000ms even if output keeps arriving. (default: no wait)' },
            },
            required: ['sessionId', 'pattern'],
          },
        },
        {
          name: 'list_sessions',
          description: 'List all active shell sessions with their metadata.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'resize_shell',
          description: 'Resize the terminal of an active shell session.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'The session ID of the shell' },
              cols: { type: 'number', description: 'New column count (1-500)' },
              rows: { type: 'number', description: 'New row count (1-200)' },
            },
            required: ['sessionId', 'cols', 'rows'],
          },
        },
        {
          name: 'end_shell_session',
          description: 'Closes the PTY and cleans up resources',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: {
                type: 'string',
                description: 'The session ID of the shell to close',
              },
            },
            required: ['sessionId'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        switch (name) {
          case 'start_shell_session':
            return await this.startShellSession(
              args?.cols as number | undefined,
              args?.rows as number | undefined,
              args?.shell as string | undefined,
              args?.cwd as string | undefined
            );

          case 'send_shell_input': {
            if (!args || typeof args.sessionId !== 'string' || typeof args.input !== 'string') {
              throw new Error('Invalid arguments for send_shell_input');
            }
            const raw = typeof args.raw === 'boolean' ? args.raw : false;
            return await this.sendShellInput(args.sessionId, args.input, raw);
          }

          case 'read_shell_output':
            if (!args || typeof args.sessionId !== 'string') {
              throw new Error('Invalid arguments for read_shell_output');
            }
            return await this.readShellOutput(
              args.sessionId,
              args.mode as 'streaming' | 'snapshot' | 'screen' | undefined,
              args.maxBytes as number | undefined,
              args.snapshotSize as number | undefined,
              args.rows as number | undefined,
              args.rowEnd as number | undefined,
              args.includeEmpty as boolean | undefined,
              args.trimWhitespace as boolean | undefined,
              args.waitForIdle as number | undefined
            );

          case 'get_screen_region':
            if (
              !args ||
              typeof args.sessionId !== 'string' ||
              typeof args.startRow !== 'number' ||
              typeof args.startCol !== 'number' ||
              typeof args.endRow !== 'number' ||
              typeof args.endCol !== 'number'
            ) {
              throw new Error('Invalid arguments for get_screen_region');
            }
            return await this.getScreenRegion(args.sessionId, args.startRow, args.startCol, args.endRow, args.endCol, args.trimWhitespace as boolean | undefined, args.waitForIdle as number | undefined);

          case 'get_screen_cursor':
            if (!args || typeof args.sessionId !== 'string') throw new Error('Invalid arguments for get_screen_cursor');
            return await this.getScreenCursor(args.sessionId, args.waitForIdle as number | undefined);

          case 'search_screen':
            if (!args || typeof args.sessionId !== 'string' || typeof args.pattern !== 'string')
              throw new Error('Invalid arguments for search_screen');
            return await this.searchScreenHandler(args.sessionId, args.pattern, args.regex as boolean | undefined, args.waitForIdle as number | undefined);

          case 'list_sessions':
            return this.listSessions();

          case 'resize_shell':
            if (!args || typeof args.sessionId !== 'string' || typeof args.cols !== 'number' || typeof args.rows !== 'number')
              throw new Error('Invalid arguments for resize_shell');
            return await this.resizeShell(args.sessionId, args.cols, args.rows);

          case 'end_shell_session':
            if (!args || typeof args.sessionId !== 'string') {
              throw new Error('Invalid arguments for end_shell_session');
            }
            return await this.endShellSession(args.sessionId);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async startShellSession(cols?: number, rows?: number, shell?: string, cwd?: string): Promise<any> {
    const sessionId = uuidv4();
    const dims = clampDimensions(cols, rows);
    const shellCmd = selectShell(shell);

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(shellCmd, [], {
        name: 'xterm-color',
        cols: dims.cols,
        rows: dims.rows,
        cwd: cwd || process.cwd(),
        env: process.env,
      });
    } catch (e) {
      throw new Error(`Failed to start shell '${shellCmd}': ${e instanceof Error ? e.message : String(e)}`);
    }

    const terminal = new Terminal({
      cols: dims.cols,
      rows: dims.rows,
      scrollback: 1000,
      allowProposedApi: true,
    });

    const session: ShellSession = {
      id: sessionId,
      shell: shellCmd,
      ptyProcess,
      outputBuffer: '',
      lastSnapshot: '',
      lastSnapshotTime: 0,
      totalBytesReceived: 0,
      maxBufferSize: DEFAULT_MAX_BUFFER_SIZE,
      terminal,
      lastWritePromise: Promise.resolve(),
      lastDataTime: Date.now(),
      lastActivityTime: Date.now(),
    };

    ptyProcess.onData((data) => {
      session.lastDataTime = Date.now();
      session.lastActivityTime = Date.now();
      session.totalBytesReceived += data.length;

      if (session.outputBuffer.length + data.length > session.maxBufferSize) {
        const keepSize = session.maxBufferSize - data.length;
        session.outputBuffer = session.outputBuffer.slice(-keepSize) + data;
      } else {
        session.outputBuffer += data;
      }

      const now = Date.now();
      if (now - session.lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
        session.lastSnapshot = session.outputBuffer.slice(-DEFAULT_SNAPSHOT_SIZE);
        session.lastSnapshotTime = now;
      }

      session.lastWritePromise = awaitWrite(terminal, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.recentlyExited.set(sessionId, { exitCode, signal, exitedAt: Date.now() });
      this.disposeSession(sessionId);
    });

    this.sessions.set(sessionId, session);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ sessionId, cols: dims.cols, rows: dims.rows }),
        },
      ],
    };
  }

  private getSession(sessionId: string): ShellSession {
    const session = this.sessions.get(sessionId);
    if (session) return session;
    const exited = this.recentlyExited.get(sessionId);
    if (exited) throw new Error(`Session exited with code ${exited.exitCode}${exited.signal ? ` (signal: ${exited.signal})` : ''}`);
    throw new Error(`Invalid session ID: ${sessionId}`);
  }

  private async waitForSessionIdle(session: ShellSession, waitForIdle?: number): Promise<void> {
    if (!waitForIdle || waitForIdle <= 0) return;
    const idleMs = Math.min(waitForIdle, MAX_WAIT_MS);
    const startTime = Date.now();
    while (Date.now() - session.lastDataTime < idleMs) {
      if (Date.now() - startTime > MAX_WAIT_MS) break;
      await new Promise(r => setTimeout(r, 50));
    }
    await session.lastWritePromise;
  }

  private parseEscapeSequences(input: string): string {
    // Convert literal escape sequence strings to actual control characters.
    // MCP clients often send "\\r" (backslash + r) instead of actual CR,
    // "\\x1b" instead of actual ESC, etc.
    //
    // Uses a single-pass regex so that "\\\\" is matched atomically as an escaped
    // backslash, preventing "\\\\x1b" from being misinterpreted as "\\<ESC>".
    const escapePattern = /\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\e|\\r|\\n|\\t|\\\\/g;
    return input.replace(escapePattern, (match, xHex, uHex) => {
      if (xHex) return String.fromCharCode(parseInt(xHex, 16));
      if (uHex) return String.fromCharCode(parseInt(uHex, 16));
      switch (match) {
        case '\\e': return '\x1b';
        case '\\r': return '\r';
        case '\\n': return '\n';
        case '\\t': return '\t';
        case '\\\\': return '\\';
        default: return match;
      }
    });
  }

  private async sendShellInput(sessionId: string, input: string, raw?: boolean): Promise<any> {
    const session = this.getSession(sessionId);

    session.lastActivityTime = Date.now();

    if (raw) {
      session.ptyProcess.write(this.parseEscapeSequences(input));
    } else {
      // Append \r (carriage return) — what a real terminal sends for Enter.
      // Interactive prompts in raw terminal mode (inquirer, clack, drizzle-kit) expect \r, not \n.
      const inputWithReturn = input.endsWith('\r') || input.endsWith('\n') ? input : input + '\r';
      session.ptyProcess.write(inputWithReturn);
    }

    return {
      content: [
        {
          type: 'text',
          text: 'Input sent successfully',
        },
      ],
    };
  }

  private detectOutputMode(session: ShellSession): 'streaming' | 'snapshot' {
    if (session.terminal.buffer.active === session.terminal.buffer.alternate) {
      return 'snapshot';
    }
    const recentOutput = session.outputBuffer.slice(-4096);
    const hasScreenClears = recentOutput.includes('\x1b[2J') || recentOutput.includes('\x1b[3J');
    return hasScreenClears ? 'snapshot' : 'streaming';
  }

  private async readShellOutput(
    sessionId: string,
    mode?: 'streaming' | 'snapshot' | 'screen',
    maxBytes?: number,
    snapshotSize?: number,
    startRow?: number,
    rowEnd?: number,
    includeEmpty?: boolean,
    trimWhitespace?: boolean,
    waitForIdle?: number
  ): Promise<any> {
    const session = this.getSession(sessionId);

    session.lastActivityTime = Date.now();

    await this.waitForSessionIdle(session, waitForIdle);

    let outputMode: 'streaming' | 'snapshot' | 'screen';
    if (mode) {
      outputMode = mode;
    } else {
      // Await pending xterm writes so detectOutputMode sees up-to-date
      // buffer state (e.g. alternate screen flag) before classifying.
      await session.lastWritePromise;
      outputMode = this.detectOutputMode(session);
    }
    const byteLimit = Math.min(maxBytes || 102400, DEFAULT_MAX_BUFFER_SIZE);

    let output: string;
    let metadata: any = {
      mode: outputMode,
      totalBytesReceived: session.totalBytesReceived,
    };

    if (outputMode === 'screen') {
      await session.lastWritePromise;
      const buf = session.terminal.buffer.active;
      output = readScreen(session.terminal, {
        startRow,
        endRow: rowEnd,
        trimWhitespace: typeof trimWhitespace === 'boolean' ? trimWhitespace : false,
        includeEmpty: typeof includeEmpty === 'boolean' ? includeEmpty : true,
      });
      metadata.cursor = { x: buf.cursorX, y: buf.cursorY };
      metadata.rows = session.terminal.rows;
      metadata.cols = session.terminal.cols;
      metadata.isAlternateBuffer = buf === session.terminal.buffer.alternate;
    } else if (outputMode === 'snapshot') {
      const now = Date.now();
      if (now - session.lastSnapshotTime >= SNAPSHOT_INTERVAL_MS || !session.lastSnapshot) {
        const snapSize = snapshotSize || DEFAULT_SNAPSHOT_SIZE;
        session.lastSnapshot = session.outputBuffer.slice(-snapSize);
        session.lastSnapshotTime = now;
      }
      output = session.lastSnapshot;
      metadata.snapshotTime = session.lastSnapshotTime;
      metadata.isSnapshot = true;
    } else {
      output = session.outputBuffer;
      if (output.length > byteLimit) {
        output = output.slice(-byteLimit);
        metadata.truncated = true;
        metadata.originalSize = session.outputBuffer.length;
      }
      session.outputBuffer = '';
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ output, metadata }),
        },
      ],
    };
  }

  private async getScreenRegion(
    sessionId: string,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    trimWhitespace?: boolean,
    waitForIdle?: number
  ): Promise<any> {
    const session = this.getSession(sessionId);
    await this.waitForSessionIdle(session, waitForIdle);
    await session.lastWritePromise;
    const output = readScreenRegion(session.terminal, startRow, startCol, endRow, endCol, trimWhitespace);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ output, region: { startRow, startCol, endRow, endCol } }),
        },
      ],
    };
  }

  private async getScreenCursor(sessionId: string, waitForIdle?: number): Promise<any> {
    const session = this.getSession(sessionId);
    await this.waitForSessionIdle(session, waitForIdle);
    await session.lastWritePromise;
    const buf = session.terminal.buffer.active;
    const cursorLine = buf.getLine(buf.viewportY + buf.cursorY);
    const currentLine = cursorLine ? cursorLine.translateToString(true) : '';
    const isAlternateBuffer = buf === session.terminal.buffer.alternate;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ cursor: { x: buf.cursorX, y: buf.cursorY }, currentLine, isAlternateBuffer }),
        },
      ],
    };
  }

  private async searchScreenHandler(sessionId: string, pattern: string, regex?: boolean, waitForIdle?: number): Promise<any> {
    const session = this.getSession(sessionId);
    await this.waitForSessionIdle(session, waitForIdle);
    await session.lastWritePromise;
    session.lastActivityTime = Date.now();
    const results = searchScreen(session.terminal, pattern, regex);
    return { content: [{ type: 'text', text: JSON.stringify({ results, count: results.length }) }] };
  }

  private listSessions(): any {
    const sessions = [];
    const now = Date.now();
    for (const session of this.sessions.values()) {
      sessions.push({
        sessionId: session.id,
        shell: session.shell,
        cols: session.terminal.cols,
        rows: session.terminal.rows,
        isAlternateBuffer: session.terminal.buffer.active === session.terminal.buffer.alternate,
        idleSeconds: Math.floor((now - session.lastActivityTime) / 1000),
      });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ sessions }) }] };
  }

  private async resizeShell(sessionId: string, cols: number, rows: number): Promise<any> {
    const session = this.getSession(sessionId);
    if (!Number.isInteger(cols) || cols < 1) throw new Error(`cols must be a positive integer, got ${cols}`);
    if (!Number.isInteger(rows) || rows < 1) throw new Error(`rows must be a positive integer, got ${rows}`);
    const c = Math.min(cols, MAX_COLS);
    const r = Math.min(rows, MAX_ROWS);
    session.ptyProcess.resize(c, r);
    session.terminal.resize(c, r);
    session.lastActivityTime = Date.now();
    return { content: [{ type: 'text', text: JSON.stringify({ cols: c, rows: r }) }] };
  }

  private disposeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try { session.terminal.dispose(); } catch (_) {}
    try { session.ptyProcess.kill(); } catch (_) {}
  }

  private async endShellSession(sessionId: string): Promise<any> {
    this.getSession(sessionId);
    this.disposeSession(sessionId);
    return {
      content: [
        {
          type: 'text',
          text: 'Session ended successfully',
        },
      ],
    };
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    for (const sessionId of [...this.sessions.keys()]) {
      this.disposeSession(sessionId);
    }
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Interactive Shell MCP server running on stdio');
  }
}

const server = new InteractiveShellServer();
server.run().catch(console.error);