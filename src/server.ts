#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';

interface ShellSession {
  id: string;
  ptyProcess: pty.IPty;
  outputBuffer: string;
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
          description: 'Writes input to the PTY with newline if needed',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: {
                type: 'string',
                description: 'The session ID of the shell',
              },
              input: {
                type: 'string',
                description: 'The input to send to the shell',
              },
            },
            required: ['sessionId', 'input'],
          },
        },
        {
          name: 'read_shell_output',
          description: 'Returns any buffered output from the PTY process since last read',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: {
                type: 'string',
                description: 'The session ID of the shell',
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
            return await this.sendShellInput(args.sessionId, args.input);

          case 'read_shell_output':
            if (!args || typeof args.sessionId !== 'string') {
              throw new Error('Invalid arguments for read_shell_output');
            }
            return await this.readShellOutput(args.sessionId);

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
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });

    const session: ShellSession = {
      id: sessionId,
      ptyProcess,
      outputBuffer: '',
    };

    ptyProcess.onData((data) => {
      session.outputBuffer += data;
    });

    ptyProcess.onExit((event) => {
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

  private async sendShellInput(sessionId: string, input: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    const inputWithNewline = input.endsWith('\n') ? input : input + '\n';
    session.ptyProcess.write(inputWithNewline);

    return {
      content: [
        {
          type: 'text',
          text: 'Input sent successfully',
        },
      ],
    };
  }

  private async readShellOutput(sessionId: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Invalid session ID: ${sessionId}`);
    }

    const output = session.outputBuffer;
    session.outputBuffer = '';

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ output }),
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