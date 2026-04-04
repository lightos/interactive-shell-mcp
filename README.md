# Interactive Shell MCP

MCP server that provides interactive shell session management
with full terminal emulation support via node-pty.

## Overview

The Interactive Shell MCP (Model Context Protocol) server enables
LLMs to create and manage interactive shell sessions. It provides
persistent shell environments where commands can be executed
sequentially while maintaining state, similar to how a human
would use a terminal.

## Features

- Create and manage multiple concurrent shell sessions
- Full terminal emulation with proper TTY support via xterm.js
- Persistent shell state across commands
- Support for interactive programs (vim, nano, htop, etc.)
- Cross-platform support (bash/zsh/fish on Unix/Linux/macOS,
  PowerShell/cmd on Windows)
- Shell allowlist for security (bash, zsh, fish, sh, dash, ksh,
  powershell.exe, pwsh, cmd.exe)
- Smart output handling with automatic mode detection
- Three output modes: streaming, snapshot, and screen
- Snapshot mode for continuously updating terminal applications
- Screen mode with virtual terminal parsing for precise output reading
- Raw input mode for interactive selection prompts
- Screen search with text and regex pattern matching
- Rectangular region extraction from terminal screen
- Cursor position tracking
- Terminal resize support
- Configurable output size limits to prevent memory overflow
- Automatic session cleanup after 10 minutes of inactivity
- Process exit detection with exit code reporting
- `waitForIdle` support across read and screen tools
- Configurable working directory per session

## Available Tools

### `start_shell_session`

Spawns a new PTY shell with a virtual terminal emulator and
returns a unique session ID.

- **Parameters**:
  - `cols` (number, optional): Terminal columns (default: 120, max: 500)
  - `rows` (number, optional): Terminal rows (default: 40, max: 200)
  - `shell` (string, optional): Shell to use. Allowed values:
    bash, zsh, fish, sh, dash, ksh, powershell.exe, pwsh, cmd.exe.
    Defaults to platform shell.
  - `cwd` (string, optional): Working directory for the shell
    (default: server process cwd)
- **Output**: `{ sessionId, cols, rows }`

### `send_shell_input`

Writes input to the PTY. Appends a carriage return by default.
Set `raw: true` for interactive prompts (arrow keys, space
to toggle, etc.).

- **Parameters**:
  - `sessionId` (string, required): The session ID of the shell
  - `input` (string, required): The input to send to the shell.
    In raw mode, use escape sequences like `\x1b[A` (up),
    `\x1b[B` (down), `\r` (enter), space for toggle
  - `raw` (boolean, optional): Send input without appending
    carriage return. Interprets escape sequences
    (`\x1b`, `\r`, `\n`, `\t`, `\e`). Default: false
- **Output**: Success confirmation

### `read_shell_output`

Returns output from the PTY process. Supports three modes:

- **Streaming mode** (default): Returns buffered output since
  last read and clears the buffer
- **Snapshot mode**: Returns the current terminal screen state
  without clearing (ideal for apps like top, htop, airodump-ng)
- **Screen mode**: Returns parsed virtual terminal screen contents
  with cursor position and buffer metadata

- **Parameters**:
  - `sessionId` (string, required): The session ID of the shell
  - `mode` (string, optional): "streaming" (default), "snapshot",
    or "screen"
  - `maxBytes` (number, optional): Maximum bytes to return
    (default: 100KB, max: 1MB)
  - `snapshotSize` (number, optional): Size of the snapshot
    buffer to capture (default: 50KB)
  - `rows` (number, optional): Start row for screen mode
    (0-based, inclusive)
  - `rowEnd` (number, optional): End row for screen mode
    (exclusive)
  - `includeEmpty` (boolean, optional): Include empty trailing
    lines in screen mode output (default: true)
  - `trimWhitespace` (boolean, optional): Trim trailing whitespace
    from each line in screen mode (default: false)
  - `waitForIdle` (number, optional): Wait until PTY output is
    idle for this many ms before reading. Max effective wait is
    5000ms even if output keeps arriving.
- **Output**:

  ```json
  {
    "output": "string",
    "metadata": {
      "mode": "streaming|snapshot|screen",
      "totalBytesReceived": 0,
      "truncated": false,
      "originalSize": 0,
      "isSnapshot": false,
      "snapshotTime": 0,
      "cursor": { "x": 0, "y": 0 },
      "rows": 40,
      "cols": 120,
      "isAlternateBuffer": false
    }
  }
  ```

### `get_screen_region`

Extracts text from a rectangular region of the terminal screen.
Coordinates are 0-based, end values are exclusive.

- **Parameters**:
  - `sessionId` (string, required): The session ID of the shell
  - `startRow` (number, required): Start row (0-based, inclusive)
  - `startCol` (number, required): Start column (0-based, inclusive)
  - `endRow` (number, required): End row (exclusive)
  - `endCol` (number, required): End column (exclusive)
  - `trimWhitespace` (boolean, optional): Trim trailing whitespace
    from each line (default: false)
  - `waitForIdle` (number, optional): Wait until PTY output is
    idle for this many ms before reading. Max 5000ms.
- **Output**: `{ output, region: { startRow, startCol, endRow, endCol } }`

### `get_screen_cursor`

Returns the current cursor position and the text of the line
the cursor is on. Lightweight alternative to reading the full screen.

- **Parameters**:
  - `sessionId` (string, required): The session ID of the shell
  - `waitForIdle` (number, optional): Wait until PTY output is
    idle for this many ms before reading. Max 5000ms.
- **Output**: `{ cursor: { x, y }, currentLine, isAlternateBuffer }`

### `search_screen`

Search the terminal screen for text or regex pattern. Returns
matching positions (capped at 50 results).

- **Parameters**:
  - `sessionId` (string, required): The session ID of the shell
  - `pattern` (string, required): Text or regex pattern to search for
  - `regex` (boolean, optional): Treat pattern as a regular
    expression (default: false)
  - `waitForIdle` (number, optional): Wait until PTY output is
    idle for this many ms before reading. Max 5000ms.
- **Output**: `{ results: [{ row, col, text }], count }`

### `list_sessions`

List all active shell sessions with their metadata.

- **Parameters**: None
- **Output**: `{ sessions: [{ sessionId, shell, cols, rows, isAlternateBuffer, idleSeconds }] }`

### `resize_shell`

Resize the terminal of an active shell session.

- **Parameters**:
  - `sessionId` (string, required): The session ID of the shell
  - `cols` (number, required): New column count (1-500)
  - `rows` (number, required): New row count (1-200)
- **Output**: `{ cols, rows }`

### `end_shell_session`

Closes the PTY and cleans up resources.

- **Parameters**:
  - `sessionId` (string, required): The session ID of the shell to close
- **Output**: Success confirmation

## Installation

```bash
npm install
npm run build
```

## MCP Configuration

To use this MCP server with Claude Desktop or VS Code, add the
following configuration to your MCP settings file:

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "Interactive Shell MCP": {
      "command": "node",
      "args": [
        "/path/to/interactive-shell-mcp/dist/src/server.js"
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
        "/path/to/interactive-shell-mcp/dist/src/server.js"
      ]
    }
  }
}
```

Replace `/path/to/interactive-shell-mcp` with the actual path
to your installation.

## Usage Examples

**Note:** The examples below demonstrate how an LLM would
interact with this MCP server. These are not JavaScript code
to be run directly, but rather illustrate the expected tool
calling patterns.

### Working with High-Output Commands

When working with commands that produce large outputs or
continuously refresh the screen (like `airodump-ng`, `htop`,
`top`), use snapshot mode:

```javascript
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
// Use default streaming mode
const output = await read_shell_output(sessionId);

// Or explicitly set a size limit for very large outputs
const output = await read_shell_output(sessionId, {
  maxBytes: 50000  // Return only last 50KB
});
```

### Using Screen Mode

For precise terminal screen reading with virtual terminal parsing:

```javascript
// Read the full parsed screen
const screen = await read_shell_output(sessionId, {
  mode: "screen",
  trimWhitespace: true,
  includeEmpty: false
});

// Read specific rows
const rows = await read_shell_output(sessionId, {
  mode: "screen",
  rows: 0,
  rowEnd: 5
});
```

### Interacting with Selection Prompts

For interactive prompts (like `db:push`, inquirer, etc.):

```javascript
// Use raw mode to send arrow keys and enter
await send_shell_input(sessionId, "\\x1b[B", { raw: true });
await send_shell_input(sessionId, "\\r", { raw: true });
```

### Waiting for Output to Settle

Use `waitForIdle` to wait until the PTY has stopped producing
output before reading:

```javascript
// Wait up to 500ms of idle before reading
const output = await read_shell_output(sessionId, {
  waitForIdle: 500
});

// Also works with screen tools
const cursor = await get_screen_cursor(sessionId, {
  waitForIdle: 300
});
```

### Searching the Screen

```javascript
// Text search
const results = await search_screen(sessionId, {
  pattern: "error"
});

// Regex search
const results = await search_screen(sessionId, {
  pattern: "\\d+ files changed",
  regex: true
});
```

### Starting a Shell with Custom Options

```javascript
// Start with specific shell and working directory
const { sessionId } = await start_shell_session({
  shell: "zsh",
  cwd: "/home/user/project",
  cols: 200,
  rows: 50
});
```

## Output Modes Explained

- **Streaming Mode**: Best for regular commands. Returns all
  output since last read and clears the buffer. Default mode
  for normal buffer.
- **Snapshot Mode**: Best for continuously updating applications
  (top, htop, airodump-ng). Returns the current terminal screen
  state without clearing. Auto-detected when alternate screen
  buffer is active or screen clears are detected.
- **Screen Mode**: Returns parsed virtual terminal screen contents.
  Provides cursor position, alternate buffer detection, and
  supports row ranges, whitespace trimming, and empty line filtering.

## Session Auto-Cleanup

Sessions are automatically cleaned up after 10 minutes (600 seconds)
of inactivity. The inactivity timer resets on any tool call that
references the session. When a shell process exits, the exit code
and signal are retained for 60 seconds so subsequent tool calls
receive informative error messages instead of "Invalid session ID".

## Shell Allowlist

For security, only the following shells can be spawned:
bash, zsh, fish, sh, dash, ksh, powershell.exe, pwsh, cmd.exe.
If an unrecognized shell is requested, the platform default is used
(SHELL environment variable on Unix, powershell.exe on Windows).

## Debugging

To run the server independently for debugging:

```bash
npm start
```

This will start the server on stdio, which is primarily useful
for testing the installation and debugging issues.

## License

MIT
