# Cloudflare Email-Inbox Worker (cf-workers/)

Catch-all email inbox via Cloudflare Email Routing + KV. Ported from grouter (`cf-workers/email-inbox-worker.js`).

## Files

| File | Purpose |
|------|---------|
| `email-inbox-worker.js` | Worker: receives email via Email Routing, stores in KV `INBOX`, serves REST API |
| `wrangler.jsonc` | Wrangler config (name, KV binding, `DOMAIN` var) |

## API (served by the worker itself)

| Endpoint | Description |
|----------|-------------|
| `GET /api/address?local=xxx&domain=xxx` | Returns `{address}` — random local part (`cf-*`) unless `?local=` given; domain from `?domain=` or `DOMAIN` var |
| `GET /api/messages?addr=xxx` | List messages for address (max 50 kept) |
| `GET /api/messages/:idx/raw?addr=xxx` | Fetch full HTML body of message `idx` |
| `DELETE /api/messages?addr=xxx` | Clear inbox for address |

## Deploy (manual; CI does not deploy this worker)

Requires [wrangler](https://developers.cloudflare.com/workers/wrangler/) + Cloudflare account with Email Routing enabled.

```bash
cd cf-workers

# 1. Create KV namespace (one-time) and paste the returned ID into wrangler.jsonc
wrangler kv namespace create INBOX

# 2. Set your fallback domain in wrangler.jsonc -> vars.DOMAIN
#    (per-domain override still works via /api/address?domain=xxx)

# 3. Deploy
wrangler deploy

# 4. Wire Email Routing catch-all:
#    Cloudflare dashboard -> yourdomain.com -> Email -> Routing rules ->
#    Catch-all action "Send to a Worker" -> select this worker.
#    After that, mail to ANY address@yourdomain.com lands in KV.
```

Verify: `curl 'https://<worker>.workers.dev/api/address?domain=yourdomain.com'` returns `{"address":"cf-xxx@yourdomain.com"}`.

Note: Email Routing mail is stored only after the catch-all rule is active; the worker URL alone receives no mail.
