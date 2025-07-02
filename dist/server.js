#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const pty = __importStar(require("node-pty"));
const uuid_1 = require("uuid");
const DEFAULT_MAX_BUFFER_SIZE = 1024 * 1024; // 1MB default limit
const SNAPSHOT_INTERVAL_MS = 100; // Minimum time between snapshots
const DEFAULT_SNAPSHOT_SIZE = 50000; // 50KB default snapshot size
class InteractiveShellServer {
    constructor() {
        this.sessions = new Map();
        this.server = new index_js_1.Server({
            name: 'interactive-shell-mcp',
            version: '1.0.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.setupToolHandlers();
        this.setupErrorHandling();
    }
    setupToolHandlers() {
        this.server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
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
        this.server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
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
                        return await this.readShellOutput(args.sessionId, args.mode, args.maxBytes, args.snapshotSize);
                    case 'end_shell_session':
                        if (!args || typeof args.sessionId !== 'string') {
                            throw new Error('Invalid arguments for end_shell_session');
                        }
                        return await this.endShellSession(args.sessionId);
                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            }
            catch (error) {
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
    async startShellSession() {
        const sessionId = (0, uuid_1.v4)();
        const ptyProcess = pty.spawn(process.platform === 'win32' ? 'powershell.exe' : 'bash', [], {
            name: 'xterm-color',
            cols: 120,
            rows: 40,
            cwd: process.cwd(),
            env: process.env,
        });
        const session = {
            id: sessionId,
            ptyProcess,
            outputBuffer: '',
            lastSnapshot: '',
            lastSnapshotTime: 0,
            totalBytesReceived: 0,
            mode: 'streaming',
            maxBufferSize: DEFAULT_MAX_BUFFER_SIZE,
        };
        ptyProcess.onData((data) => {
            session.totalBytesReceived += data.length;
            // Always append to buffer first
            if (session.outputBuffer.length + data.length > session.maxBufferSize) {
                // Calculate exact amount to keep to stay within limit
                const keepSize = session.maxBufferSize - data.length;
                session.outputBuffer = session.outputBuffer.slice(-keepSize) + data;
            }
            else {
                session.outputBuffer += data;
            }
            // Detect if this looks like a screen refresh (contains clear screen or cursor positioning)
            const hasTerminalControls = data.includes('\x1b[H') || // Cursor home
                data.includes('\x1b[2J') || // Clear screen
                data.includes('\x1b[0;0H') || // Cursor to 0,0
                data.includes('\x1b[?1049h') || // Alternate screen buffer on
                data.includes('\x1b[?1049l') || // Alternate screen buffer off
                data.includes('\x1b[?47h') || // Alternate screen on
                data.includes('\x1b[?47l') || // Alternate screen off
                data.includes('\x1b[1;1H') || // Cursor to 1,1
                data.includes('\x1b[J') || // Clear from cursor down
                data.includes('\x1b[0J') || // Clear from cursor down
                data.includes('\x1b[1J') || // Clear from cursor up
                data.includes('\x1b[3J') || // Clear entire screen and scrollback
                /\x1b\[\d+;\d+H/.test(data) || // Cursor positioning
                /\x1b\[\d+;\d+f/.test(data); // Cursor positioning (alternate)
            if (hasTerminalControls || session.mode === 'snapshot') {
                // Switch to or stay in snapshot mode for apps that refresh the screen
                session.mode = 'snapshot';
                const now = Date.now();
                // Always update snapshot in snapshot mode, respecting rate limit
                if (now - session.lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
                    // For snapshot mode, capture the recent buffer which should contain the full screen
                    session.lastSnapshot = session.outputBuffer.slice(-DEFAULT_SNAPSHOT_SIZE);
                    session.lastSnapshotTime = now;
                }
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
    async sendShellInput(sessionId, input) {
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
    async readShellOutput(sessionId, mode, maxBytes, snapshotSize) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Invalid session ID: ${sessionId}`);
        }
        // Use session's detected mode if not explicitly specified
        const outputMode = mode || session.mode;
        const byteLimit = Math.min(maxBytes || 102400, DEFAULT_MAX_BUFFER_SIZE);
        let output;
        let metadata = {
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
        }
        else {
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
    async endShellSession(sessionId) {
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
    setupErrorHandling() {
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
    async cleanup() {
        for (const session of this.sessions.values()) {
            try {
                session.ptyProcess.kill();
            }
            catch (error) {
                console.error('Error killing PTY process:', error);
            }
        }
        this.sessions.clear();
    }
    async run() {
        const transport = new stdio_js_1.StdioServerTransport();
        await this.server.connect(transport);
        console.error('Interactive Shell MCP server running on stdio');
    }
}
const server = new InteractiveShellServer();
server.run().catch(console.error);
//# sourceMappingURL=server.js.map