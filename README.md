# mbs

MBS Billing Assistant for Healthcare Professionals in Australia.

This repository provides an MCP server that can look up an Australian MBS item number and answer with the scheduled fee, Medicare rebate, or both. It supports both **stdio** (local subprocess) and **Streamable HTTP** (Render / remote) transports.

## Local usage — stdio

Use this when running Claude Code locally with the server as a subprocess:

```bash
npm install
MCP_TRANSPORT=stdio node server.js
```

Add to Claude Code:

```bash
claude mcp add --transport stdio mbs -- node "$(pwd)/server.js" --env MCP_TRANSPORT=stdio
```

## Local usage — HTTP

Start the HTTP server locally (default port 3000):

```bash
npm install
npm start
```

The MCP endpoint is available at `http://localhost:3000/mcp`.  
Health check: `http://localhost:3000/health`

Add to Claude Code (local HTTP):

```bash
claude mcp add --transport http mbs http://localhost:3000/mcp
```

## Render deployment

The `npm start` command (`node server.js`) starts the Streamable HTTP server on `process.env.PORT` automatically — no changes needed for Render.

After deploying to Render, add the hosted endpoint to Claude Code:

```bash
claude mcp add --transport http mbs https://mbs-not5.onrender.com/mcp
```

Health check: `https://mbs-not5.onrender.com/health`

## MCP tool

- `lookup_mbs_item`
  - Inputs:
    - `itemNumber`: MBS item number, for example `23`
    - `focus`: `fee`, `rebate`, or `both`

By default the server queries the official MBS Online item page at `https://www9.health.gov.au/mbs/fullDisplay.cfm?type=item&q=<itemNumber>`.

## Optional environment variables

- `MCP_TRANSPORT`: set to `stdio` to use stdio transport instead of HTTP
- `PORT`: HTTP port (default `3000`; set automatically by Render)
- `MBS_API_BASE_URL`: override the lookup endpoint for local testing or alternate integrations
- `MBS_API_TIMEOUT_MS`: override the HTTP timeout used for MBS lookups
