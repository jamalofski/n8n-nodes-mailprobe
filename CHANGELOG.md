# Changelog

## 1.0.1 (2026-09-25)

- The npm package no longer ships the TypeScript build cache (`tsconfig.tsbuildinfo`): 35 kB unpacked instead of 243 kB. No change to the node itself.

## 1.0.0 (2026-09-25)

First release.

- **Email > Verify** verifies the address of each input item. Addresses go to MailProbe 20 at a time, the most the API accepts in one request, and the results come back in the input order.
- **Account > Get Credits** returns the remaining credit balance. The credential test uses the same free endpoint.
- Waits for `Retry-After` when the API rate-limits the key, and never retries a request that may already have been billed.
- Usable as a tool by the n8n AI Agent.
