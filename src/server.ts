#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';

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
  detectedOutputMode?: 'streaming' | 'snapshot';
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
          description: 'Spawns a new PTY shell and returns a unique session ID',
          inputSchema: {
            type: 'object',
            properties: {},
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
          description: 'Returns output from the PTY process. Supports two modes: streaming (default) returns buffered output since last read, snapshot mode returns current terminal state',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: {
                type: 'string',
                description: 'The session ID of the shell',
              },
              mode: {
                type: 'string',
                enum: ['streaming', 'snapshot'],
                description: 'Output mode: streaming (default) for regular commands, snapshot for continuously updating apps like top/htop/airodump-ng',
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
            return await this.startShellSession();

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
              args.mode as 'streaming' | 'snapshot' | undefined,
              args.maxBytes as number | undefined,
              args.snapshotSize as number | undefined
            );

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

  private async startShellSession(): Promise<any> {
    const sessionId = uuidv4();
    
    const ptyProcess = pty.spawn(process.platform === 'win32' ? 'powershell.exe' : 'bash', [], {
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: process.env,
    });

    const session: ShellSession = {
      id: sessionId,
      ptyProcess,
      outputBuffer: '',
      lastSnapshot: '',
      lastSnapshotTime: 0,
      totalBytesReceived: 0,
      maxBufferSize: DEFAULT_MAX_BUFFER_SIZE,
    };

    ptyProcess.onData((data) => {
      session.totalBytesReceived += data.length;
      
      // Always append to buffer first
      if (session.outputBuffer.length + data.length > session.maxBufferSize) {
        // Calculate exact amount to keep to stay within limit
        const keepSize = session.maxBufferSize - data.length;
        session.outputBuffer = session.outputBuffer.slice(-keepSize) + data;
      } else {
        session.outputBuffer += data;
      }
      
      // Track alternate screen buffer transitions to update sticky mode
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        session.detectedOutputMode = 'snapshot';
      } else if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
        session.detectedOutputMode = undefined;
      }

      // Always maintain the snapshot buffer so it's available when requested
      const now = Date.now();
      if (now - session.lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
        session.lastSnapshot = session.outputBuffer.slice(-DEFAULT_SNAPSHOT_SIZE);
        session.lastSnapshotTime = now;
      }
    });

    ptyProcess.onExit(() => {
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ sessionId }),
        },
      ],
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
    const buf = session.outputBuffer;
    // Check recent buffer for terminal control sequences indicating a full-screen app
    const hasTerminalControls =
      buf.includes('\x1b[?1049h') ||     // Alternate screen buffer on
      buf.includes('\x1b[?47h') ||       // Alternate screen on
      buf.includes('\x1b[2J') ||         // Clear entire screen
      buf.includes('\x1b[3J');           // Clear screen and scrollback

    // Only auto-detect snapshot for strong signals (full-screen apps),
    // not for minor cursor positioning used by selection prompts
    return hasTerminalControls ? 'snapshot' : 'streaming';
  }

  private async readShellOutput(
    sessionId: string,
    mode?: 'streaming' | 'snapshot',
    maxBytes?: number,
    snapshotSize?: number
  ): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    // Mode resolution: explicit caller mode > sticky detected mode > fresh detection
    let outputMode: 'streaming' | 'snapshot';
    if (mode) {
      outputMode = mode;
    } else if (session.detectedOutputMode) {
      outputMode = session.detectedOutputMode;
    } else {
      outputMode = this.detectOutputMode(session);
      session.detectedOutputMode = outputMode;
    }
    const byteLimit = Math.min(maxBytes || 102400, DEFAULT_MAX_BUFFER_SIZE);
    
    let output: string;
    let metadata: any = {
      mode: outputMode,
      totalBytesReceived: session.totalBytesReceived,
    };

    if (outputMode === 'snapshot') {
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

  private async endShellSession(sessionId: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    session.ptyProcess.kill();
    this.sessions.delete(sessionId);

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
    for (const session of this.sessions.values()) {
      try {
        session.ptyProcess.kill();
      } catch (error) {
        console.error('Error killing PTY process:', error);
      }
    }
    this.sessions.clear();
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Interactive Shell MCP server running on stdio');
  }
}

const server = new InteractiveShellServer();
server.run().catch(console.error);