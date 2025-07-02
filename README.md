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
- Smart output handling with automatic mode detection
- Snapshot mode for continuously updating terminal applications
- Configurable output size limits to prevent memory overflow
- Automatic detection of terminal control sequences

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
Returns output from the PTY process with support for two modes:
- **Streaming mode** (default): Returns buffered output since last read and clears the buffer
- **Snapshot mode**: Returns the current terminal screen state without clearing (ideal for apps like top, htop, airodump-ng)

- **Input**: 
  - `sessionId` (string): The session ID of the shell
  - `mode` (string, optional): Output mode - "streaming" (default) or "snapshot"
  - `maxBytes` (number, optional): Maximum bytes to return (default: 100KB, max: 1MB)
  - `snapshotSize` (number, optional): Size of the snapshot buffer to capture (default: 50KB)
- **Output**: 
  ```json
  {
    "output": "string",
    "metadata": {
      "mode": "streaming|snapshot",
      "totalBytesReceived": number,
      "truncated": boolean,
      "originalSize": number,
      "isSnapshot": boolean,
      "snapshotTime": number
    }
  }
  ```

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

## Usage Examples

**Note:** The examples below demonstrate how an LLM would interact with this MCP server. These are not JavaScript code to be run directly, but rather illustrate the expected tool calling patterns.

### Working with High-Output Commands

When working with commands that produce large outputs or continuously refresh the screen (like `airodump-ng`, `htop`, `top`), use snapshot mode:

```javascript
// Example of how an LLM would call these tools:
// Start a session
const { sessionId } = await start_shell_session();

// Run airodump-ng
await send_shell_input(sessionId, "sudo airodump-ng wlan0mon");

// Read output in snapshot mode to get current screen state
const result = await read_shell_output(sessionId, {
  mode: "snapshot"
});
```

### Handling Regular Commands

For normal commands that produce streaming output:

```javascript
// Example of how an LLM would call these tools:
// Use default streaming mode
const output = await read_shell_output(sessionId);

// Or explicitly set a size limit for very large outputs
const output = await read_shell_output(sessionId, {
  maxBytes: 50000  // Return only last 50KB
});
```

## Output Modes Explained

- **Streaming Mode**: Best for regular commands. Returns all output since last read and clears the buffer.
- **Snapshot Mode**: Best for continuously updating applications. Returns the current terminal screen state without clearing. The server automatically switches to this mode when it detects terminal control sequences.

## Debugging

To run the server independently for debugging:

```bash
npm start
```

This will start the server on stdio, which is primarily useful for testing the installation and debugging issues.

## License

MIT