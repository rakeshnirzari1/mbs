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

By default the server queries the public MBS API at `https://mbsr_api_services.health.gov.au/v1/mbsitems`.
You can override the endpoint with `MBS_API_BASE_URL` for local testing.
