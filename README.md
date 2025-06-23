# Interactive Shell MCP

MCP server that provides interactive shell session management with full terminal emulation support via node-pty

## Overview

The Interactive Shell MCP (Model Context Protocol) server enables LLMs to create and manage interactive shell sessions. It provides persistent shell environments where commands can be executed sequentially while maintaining state, similar to how a human would use a terminal.

## Features

- Create and manage multiple concurrent shell sessions
- Full terminal emulation with proper TTY support
- Persistent shell state across commands
- Support for interactive programs (vim, nano, etc.)
- Cross-platform support (bash on Unix/Linux/macOS, PowerShell on Windows)

## Available Tools

### `start_shell_session`
Spawns a new PTY shell and returns a unique session ID.
- **Input**: None
- **Output**: `{ sessionId: string }`

### `send_shell_input`
Writes input to the PTY with automatic newline handling.
- **Input**: 
  - `sessionId` (string): The session ID of the shell
  - `input` (string): The input to send to the shell
- **Output**: Success confirmation

### `read_shell_output`
Returns any buffered output from the PTY process since last read.
- **Input**: 
  - `sessionId` (string): The session ID of the shell
- **Output**: `{ output: string }`

### `end_shell_session`
Closes the PTY and cleans up resources.
- **Input**: 
  - `sessionId` (string): The session ID of the shell to close
- **Output**: Success confirmation

## Installation

```bash
npm install
npm run build
```

## MCP Configuration

To use this MCP server with Claude Desktop or VS Code, add the following configuration to your MCP settings file:

### Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "Interactive Shell MCP": {
      "command": "node",
      "args": [
        "/path/to/interactive-shell-mcp/dist/server.js"
      ]
    }
  }
}
```

### VS Code (Cursor)
Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "Interactive Shell MCP": {
      "command": "node",
      "args": [
        "/path/to/interactive-shell-mcp/dist/server.js"
      ]
    }
  }
}
```

Replace `/path/to/interactive-shell-mcp` with the actual path to your installation.

## Debugging

To run the server independently for debugging:

```bash
npm start
```

This will start the server on stdio, which is primarily useful for testing the installation and debugging issues.

## License

MIT