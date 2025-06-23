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

## Dependencies

- `@modelcontextprotocol/sdk` - MCP SDK for building MCP servers
- `node-pty` - Node.js bindings for pseudo-terminals
- `uuid` - UUID generation for session management

## License

MIT