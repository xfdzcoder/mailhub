# Model outbound policy

Deployment environment is the authority for outbound approval. Tenant AI settings
select an endpoint and tenant key; they cannot grant network approval. No schema
changes or new settings API are required. The existing instance settings API
continues to require INSTANCE_ADMIN_USER_IDS and current admin membership; an
organization admin cannot edit this deployment policy through that API.

MODEL_ORIGIN_POLICY is a JSON array of exact origins, replacing the defaults
https://api.openai.com and https://api.anthropic.com. An omitted addresses field
permits only public DNS answers for that origin. An addresses array contains
explicit allowed IP literals or CIDRs; **every** answer must match. For example:

```json
[
  {"origin":"https://api.openai.com"},
  {"origin":"http://localhost:11434","addresses":["127.0.0.1/32","::1/128"]},
  {"origin":"http://model:11434","addresses":["192.0.2.10/32"]}
]
```

The last address is a documentation example: operators must substitute the actual
container/service addresses in their private deployment configuration. Approve
only the smallest required ranges. Local, container and private services are
supported but never implicitly trusted. Existing custom URLs need explicit
approval before rollout; merely setting AI_BASE_URL does not approve an origin.
Malformed policy fails closed. The mail host allowlist and notification settings
have no effect on model approval. Notification adapters use the separate [notification policy](notification-origin-policy.md).

Tenant endpoints use the tenant key or no key. Shared AI_API_KEY/OPENAI_API_KEY
credentials are used only when no tenant endpoint is selected, and only at
AI_SHARED_CREDENTIAL_ORIGIN (default OpenAI, or Anthropic for AI_PROVIDER=claude).
For a deployment custom provider, configure both approval and the shared origin.
A tenant provider setting without a key can still use the shared key at its
approved default origin. Tenant endpoint selection never inherits a shared key.

Connections resolve on every request, validate all answers, and connect directly
to one checked address. Host headers, TLS SNI and certificate verification retain
the original hostname. There is no fallback DNS lookup, connection pool, redirect
following or retry. HTTP_PROXY, HTTPS_PROXY, ALL_PROXY and NO_PROXY are ignored;
operators needing an egress proxy must provide a separately reviewed integration.
HTTPS certificate validation is mandatory. HTTP is supported for approved local
services; operators must account for the lack of transport encryption.

The total deadline is 20 seconds, including DNS and response consumption; the
connection/TLS deadline is 5 seconds. Responses, including JSON, are capped at
2 MiB. Failed status codes and redirects are rejected without consuming bodies.
Errors do not include response bodies, resolved addresses or credentials.

Roll out environment changes to both web and worker processes. Verify approved
provider and local-service requests in staging, then verify that an unapproved
origin fails with configuration guidance. Do not publish deployment addresses or
keys. Production networking/proxy arrangements and operator-specific certificates
must be validated privately; local tests cannot validate deployed infrastructure.

## Implementation validation

Validated with Node 24.22.2: lint (existing repository warnings), the complete Jest
suite, TypeScript without emitting files, and the production Next.js build.
The build can emit Redis connection warnings when no local Redis is running.
Tests use controlled local HTTP/TLS sinks and synthetic DNS answers; they do not
contact metadata endpoints, deployed mailboxes or external model providers.
The TLS mismatch fixture is generated temporarily with OpenSSL, which is required
in the test environment. No certificate trust or TLS verification is disabled.
