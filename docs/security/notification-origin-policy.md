# Notification outbound policy

Operators must approve notification origins in `NOTIFICATION_ORIGIN_POLICY` in
both web and worker environments. The default is deny all. Tenant webhook URLs,
headers and secrets cannot grant approval. `MODEL_ORIGIN_POLICY`, shared model
keys and the mail host allowlist do not authorize notification delivery.

The policy uses the shared model transport's JSON format: exact scheme, hostname
and port, with optional `addresses` containing IP literals or CIDRs. For example:

```json
[
  {"origin":"https://api.telegram.org"},
  {"origin":"https://qyapi.weixin.qq.com"},
  {"origin":"http://notifications.example:8080","addresses":["192.0.2.10/32"]}
]
```

The last entry is a documentation fixture. Substitute the actual service origin
and smallest required address ranges privately. Without `addresses`, every DNS
answer must be public. Explicit address ranges preserve approved self-hosted
services, including private services. Existing deployments must configure this
policy before rollout. Invalid policies fail closed.

Generic Webhook, Telegram and WeCom use direct connections pinned to a checked
DNS answer, revalidated on each delivery. All answers must pass policy. The
connected address is checked; TLS retains the URL hostname for SNI and certificate
verification. No environment proxies, connection pools or retries are used.
Redirects, including same-origin and independently approved cross-origin
redirects, are rejected. There is no origin transition that can forward headers,
path/query credentials or notification bodies; configure the final URL explicitly.

Connection/TLS establishment is limited to 5 seconds; the total deadline is 20
seconds including DNS and body consumption. Replies are discarded under a 64 KiB
cap. Non-2xx replies are rejected without reading their bodies. Routing, proxy,
framing and upgrade headers cannot be supplied as custom headers. URL userinfo,
fragments and ambiguous URL spellings are rejected. Query credentials are allowed
for WeCom and webhook services; Telegram tokens are encoded into their path segment.
Diagnostics use fixed, short messages and optional HTTP status, never remote
bodies, socket errors, endpoint paths, queries or secrets. Credential storage and
encryption formats are unchanged (issue #27).

Tests use synthetic DNS and controlled HTTP/TLS sinks, including a temporarily
generated OpenSSL certificate. No real notifications are sent. Deployed DNS,
networking, operator certificates and production delivery require private staging
validation; local fixtures do not provide that integration evidence.

Implementation validation used Node 24.22.2: all 106 Jest suites (671 tests),
TypeScript without emitting files, lint (83 existing warnings, no errors), and the
production build passed. The build emitted connection warnings because local
Redis was unavailable. The Prisma client was generated locally for validation;
no schema changes or migrations were applied.
