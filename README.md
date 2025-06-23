# Interactive Shell MCP

MCP server for interactive shell sessions

## Overview

The Interactive Shell MCP (Model Context Protocol) server provides a way to create and manage interactive shell sessions through the MCP protocol. It uses `node-pty` to create pseudo-terminal sessions that can be controlled programmatically.

## Features

- Create interactive shell sessions
- Execute commands in persistent shell environments
- Full terminal emulation support via node-pty
- Session management with unique identifiers

## Installation

```bash
npm install
```

## Build

```bash
npm run build
```

## Usage

### Running the server

```bash
npm start
```

### Development mode

```bash
npm run dev
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

## Dependencies

- `@modelcontextprotocol/sdk` - MCP SDK for building MCP servers
- `node-pty` - Node.js bindings for pseudo-terminals
- `uuid` - UUID generation for session management

## License

MIT