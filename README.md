# n8n-nodes-mailprobe

Official [n8n](https://n8n.io) node for [MailProbe](https://mailprobe.dev), the email verification API: check whether addresses can receive mail and detect disposable and role-based addresses, straight from your workflows.

[Installation](#installation) · [Operations](#operations) · [Credentials](#credentials) · [Usage](#usage) · [Output](#output) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/): in n8n, open **Settings > Community Nodes**, select **Install** and enter `n8n-nodes-mailprobe`.

## Operations

- **Email > Verify**: verifies the address given for each input item. The node sends the items to MailProbe 20 at a time, the most the API accepts in one request, and returns one result per item, in the input order.
- **Account > Get Credits**: returns your remaining credit balance.

## Credentials

1. Create a MailProbe account at [mailprobe.dev](https://mailprobe.dev). See [pricing](https://mailprobe.dev/pricing/) for free and paid credits.
2. Copy your API key, which starts with `mp_live_`, from the API keys section of your [dashboard](https://mailprobe.dev/dashboard/).
3. In n8n, create a **MailProbe API** credential and paste the key. The credential test reads your balance, which costs no credit.

## Usage

- **Credits.** Each verified address costs one credit. Duplicates within a request, addresses with invalid syntax and servers that refuse MailProbe itself are not billed.
- **Rate limit.** The API accepts 60 requests per minute per API key. When it answers with a rate-limit error, the node waits for the delay the API gives (`Retry-After`) and tries again, up to five times.
- **Errors.** With the node's **On Error** setting on *Continue*, a failed item comes out with an `error` field and the others carry on. A rejected API key, spent credits or an unreachable API stop the requests for the rest of the run. An address on a domain that needs purchased credits only fails that address.
- **Retry On Fail.** Leave it off for this node. MailProbe bills the addresses it has already probed when a request is interrupted, so re-running a request that timed out bills them a second time. The node retries on its own only when the API says it is safe (rate limit).
- **AI agents.** The node can be used as a tool by the n8n AI Agent, for example to check an address before sending an email.
- **Large lists.** For lists of thousands of addresses, the batch screen of the MailProbe dashboard runs in the background and retries temporary deferrals later.

Every request carries `User-Agent: n8n-nodes-mailprobe/<version>`. Mention it when you contact support: it tells your calls apart in the API's logs.

## Output

Each output item is MailProbe's result for the address, exactly as the API returns it. The main fields:

| Field | Meaning |
|---|---|
| `email` | The address, lower-cased and trimmed |
| `status` | `valid`, `risky`, `invalid` or `unknown`: the field most workflows filter on |
| `score` | Confidence from 0 to 100 |
| `result` | Raw verdict: `deliverable`, `undeliverable`, `catch-all` or `unknown` |
| `reason` | Why the verdict is not a plain `deliverable`, for example `accept_all`, `greylisting` or `no_mx` |
| `disposable`, `role_based`, `free_provider`, `catch_all` | Flags about the address and its domain |
| `did_you_mean` | Suggested correction for a likely typo, such as `gmial.com` |
| `retry_after` | Suggested wait, in seconds, after a temporary deferral |

`risky` includes Microsoft consumer mailboxes (outlook.com, hotmail.com), which cannot be probed: to keep them, filter on `score` rather than dropping every `risky` address.

The full list of fields and reasons is in the [API documentation](https://mailprobe.dev/api-docs/).

## Compatibility

Built and tested against `n8n-workflow` 2.40.

## Resources

- [MailProbe API documentation](https://mailprobe.dev/api-docs/)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## Support

Open an [issue](https://github.com/jamalofski/n8n-nodes-mailprobe/issues) or write to contact@mailprobe.dev.

## License

MIT, see [LICENSE](LICENSE).
