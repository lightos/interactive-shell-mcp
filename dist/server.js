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
                        return await this.readShellOutput(args.sessionId);
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
            cols: 80,
            rows: 24,
            cwd: process.cwd(),
            env: process.env,
        });
        const session = {
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
    async readShellOutput(sessionId) {
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