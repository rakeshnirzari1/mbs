# mbs

MBS Billing Assistant for Healthcare Professionals in Australia.

This repository now provides an MCP server that can look up an Australian MBS item number and answer with the scheduled fee, Medicare rebate, or both.

## Run locally

```bash
npm install
npm start
```

## MCP tool

- `lookup_mbs_item`
  - Inputs:
    - `itemNumber`: MBS item number, for example `23`
    - `focus`: `fee`, `rebate`, or `both`

By default the server queries the official MBS Online item page at `https://www9.health.gov.au/mbs/fullDisplay.cfm?type=item&q=<itemNumber>`.

Optional environment variables:

- `MBS_API_BASE_URL`: override the lookup endpoint for local testing or alternate integrations
- `MBS_API_TIMEOUT_MS`: override the HTTP timeout used for MBS lookups
