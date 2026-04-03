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
import { readScreen, readScreenRegion, awaitWrite, clampDimensions } from './screen';

const DEFAULT_MAX_BUFFER_SIZE = 1024 * 1024; // 1MB default limit
const SNAPSHOT_INTERVAL_MS = 100; // Minimum time between snapshots
const DEFAULT_SNAPSHOT_SIZE = 50000; // 50KB default snapshot size

interface ShellSession {
  id: string;
  ptyProcess: pty.IPty;
  outputBuffer: string;
  lastSnapshot: string;
  lastSnapshotTime: number;
  totalBytesReceived: number;
  maxBufferSize: number;
  terminal: Terminal;
  lastWritePromise: Promise<void>;
}

class InteractiveShellServer {
  private server: Server;
  private sessions: Map<string, ShellSession> = new Map();

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
            },
            required: ['sessionId'],
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
              args?.rows as number | undefined
            );

          case 'send_shell_input':
            if (!args || typeof args.sessionId !== 'string' || typeof args.input !== 'string') {
              throw new Error('Invalid arguments for send_shell_input');
            }
            const raw = typeof args.raw === 'boolean' ? args.raw : false;
            return await this.sendShellInput(args.sessionId, args.input, raw);

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
              args.trimWhitespace as boolean | undefined
            );

          case 'get_screen_region':
            if (!args || typeof args.sessionId !== 'string' || typeof args.startRow !== 'number' || typeof args.startCol !== 'number' || typeof args.endRow !== 'number' || typeof args.endCol !== 'number') {
              throw new Error('Invalid arguments for get_screen_region');
            }
            return await this.getScreenRegion(args.sessionId, args.startRow, args.startCol, args.endRow, args.endCol);

          case 'get_screen_cursor':
            if (!args || typeof args.sessionId !== 'string') throw new Error('Invalid arguments for get_screen_cursor');
            return await this.getScreenCursor(args.sessionId);

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

  private async startShellSession(cols?: number, rows?: number): Promise<any> {
    const sessionId = uuidv4();
    const dims = clampDimensions(cols, rows);

    const ptyProcess = pty.spawn(process.platform === 'win32' ? 'powershell.exe' : 'bash', [], {
      name: 'xterm-color',
      cols: dims.cols,
      rows: dims.rows,
      cwd: process.cwd(),
      env: process.env,
    });

    const terminal = new Terminal({
      cols: dims.cols,
      rows: dims.rows,
      scrollback: 1000,
      allowProposedApi: true,
    });

    const session: ShellSession = {
      id: sessionId,
      ptyProcess,
      outputBuffer: '',
      lastSnapshot: '',
      lastSnapshotTime: 0,
      totalBytesReceived: 0,
      maxBufferSize: DEFAULT_MAX_BUFFER_SIZE,
      terminal,
      lastWritePromise: Promise.resolve(),
    };

    ptyProcess.onData((data) => {
      session.totalBytesReceived += data.length;

      // Raw buffer (existing behavior)
      if (session.outputBuffer.length + data.length > session.maxBufferSize) {
        const keepSize = session.maxBufferSize - data.length;
        session.outputBuffer = session.outputBuffer.slice(-keepSize) + data;
      } else {
        session.outputBuffer += data;
      }

      // Snapshot buffer (existing behavior)
      const now = Date.now();
      if (now - session.lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
        session.lastSnapshot = session.outputBuffer.slice(-DEFAULT_SNAPSHOT_SIZE);
        session.lastSnapshotTime = now;
      }

      // Feed xterm terminal (new)
      session.lastWritePromise = awaitWrite(terminal, data);
    });

    ptyProcess.onExit(() => {
      this.disposeSession(sessionId);
    });

    this.sessions.set(sessionId, session);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ sessionId, cols: dims.cols, rows: dims.rows }),
      }],
    };
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
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

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
    const isAlternateBuffer =
      session.terminal.buffer.active === session.terminal.buffer.alternate;
    if (isAlternateBuffer) {
      return 'snapshot';
    }
    const recentOutput = session.outputBuffer.slice(-4096);
    const hasScreenClears =
      recentOutput.includes('\x1b[2J') ||
      recentOutput.includes('\x1b[3J');
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
    trimWhitespace?: boolean
  ): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    let outputMode: 'streaming' | 'snapshot' | 'screen';
    if (mode) {
      outputMode = mode;
    } else {
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
      const isAlternateBuffer =
        session.terminal.buffer.active === session.terminal.buffer.alternate;
      const buf = session.terminal.buffer.active;
      output = readScreen(session.terminal, {
        startRow: startRow,
        endRow: rowEnd,
        trimWhitespace: typeof trimWhitespace === 'boolean' ? trimWhitespace : false,
        includeEmpty: typeof includeEmpty === 'boolean' ? includeEmpty : true,
      });
      metadata.cursor = { x: buf.cursorX, y: buf.cursorY };
      metadata.rows = session.terminal.rows;
      metadata.cols = session.terminal.cols;
      metadata.isAlternateBuffer = isAlternateBuffer;
    } else if (outputMode === 'snapshot') {
      // In snapshot mode, check if we need to update the snapshot
      const now = Date.now();
      if (now - session.lastSnapshotTime >= SNAPSHOT_INTERVAL_MS || !session.lastSnapshot) {
        // Update snapshot with current buffer content
        const snapSize = snapshotSize || DEFAULT_SNAPSHOT_SIZE;
        session.lastSnapshot = session.outputBuffer.slice(-snapSize);
        session.lastSnapshotTime = now;
      }
      
      output = session.lastSnapshot;
      metadata.snapshotTime = session.lastSnapshotTime;
      metadata.isSnapshot = true;
      
      // Don't clear the buffer in snapshot mode
    } else {
      // In streaming mode, return buffered output and clear it
      output = session.outputBuffer;
      
      // If output exceeds limit, return only the most recent data
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
          text: JSON.stringify({ 
            output,
            metadata 
          }),
        },
      ],
    };
  }

  private async getScreenRegion(sessionId: string, startRow: number, startCol: number, endRow: number, endCol: number): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Invalid session ID: ${sessionId}`);
    await session.lastWritePromise;
    const output = readScreenRegion(session.terminal, startRow, startCol, endRow, endCol);
    return {
      content: [{ type: 'text', text: JSON.stringify({ output, region: { startRow, startCol, endRow, endCol } }) }],
    };
  }

  private async getScreenCursor(sessionId: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Invalid session ID: ${sessionId}`);
    await session.lastWritePromise;
    const buf = session.terminal.buffer.active;
    const cursorLine = buf.getLine(buf.viewportY + buf.cursorY);
    const currentLine = cursorLine ? cursorLine.translateToString(true) : '';
    const isAlternateBuffer = session.terminal.buffer.active === session.terminal.buffer.alternate;
    return {
      content: [{ type: 'text', text: JSON.stringify({ cursor: { x: buf.cursorX, y: buf.cursorY }, currentLine, isAlternateBuffer }) }],
    };
  }

  private disposeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try { session.terminal.dispose(); } catch (_) {}
    try { session.ptyProcess.kill(); } catch (_) {}
  }

  private async endShellSession(sessionId: string): Promise<any> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }
    this.disposeSession(sessionId);
    return {
      content: [{ type: 'text', text: 'Session ended successfully' }],
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