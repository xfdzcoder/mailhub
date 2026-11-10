# Authentication request controls

Set AUTH_TRUSTED_ORIGINS to a comma-separated list of exact origins (scheme,
host and port, no trailing slash); otherwise NEXT_PUBLIC_APP_URL is used.
No origin is inferred from Host or forwarded headers. Cookie mutations require
Origin, including refresh/logout. Same-site sibling domains and `null` origins
are denied unless their exact origin is explicitly trusted. Fetch Metadata does
not substitute for Origin. Non-browser clients must send a bearer credential,
no cookies, and no Fetch Metadata when omitting Origin. Mutation bodies must be JSON, including login/registration. Empty bodies are
allowed for action requests such as logout/refresh/DELETE. Provider GET callbacks are unchanged.

Next.js does not expose the TCP peer to route handlers. By default no forwarding
headers are trusted. Optional AUTH_TRUSTED_CLIENT_IP_HEADER names a dedicated
single-IP header set by the deployment's explicitly trusted ingress. Also set
AUTH_TRUSTED_PROXY_SECRET to at least 32 random characters and configure that
ingress to overwrite X-Mailhub-Proxy-Token with the same secret. The application
checks this proof before trusting the client-IP header; missing or incorrect
proofs use the unattributed budget. Keep this secret server-side and use a
protected transport between the ingress and application. Enable it
only when direct access to the application is blocked and the ingress strips and
overwrites both headers on every request. Do not point it at a header supplied by
clients or a comma-separated forwarding chain. Invalid/missing IPs share the
unattributed ingress budget. X-Forwarded-For and Forwarded are never interpreted.

Each endpoint class permits 20 attempts per principal per fixed 15-minute window
and 500 per trusted client IP (or unattributed ingress), with 4 and 40 concurrent
leases respectively. This allows distinct principals behind NAT independent
small budgets with a larger shared ceiling. Sensitive operations use verified
user and tenant IDs, with an additional tenant ceiling of 100 attempts and 20
concurrent leases. Login/registration use a hashed normalized email; refresh
and logout use verified user IDs that remain stable across token rotations. Keys contain no raw emails, IPs or tokens.
Budgets are shared by all processes through one atomic Redis Lua script and
share a Redis Cluster hash slot. Denials do not extend expiry. Success does not
reset the budget. Concurrency leases expire in 120 seconds to recover crashes;
operations that outlive that lease may overlap later admissions. Release runs
on both success and exceptions. 429 responses conservatively request retry in
900 seconds. Redis failures return 503 with a five-second retry and never fall
back to an in-process limiter. The limiter uses a separate bounded Redis
connection, not the unlimited-retry BullMQ connection.

New bcrypt passwords are limited to 72 UTF-8 bytes. Existing password verification
accepts up to 4096 UTF-8 bytes and passes the original credential unchanged to
bcrypt, preserving legacy credentials rather than truncating inputs in the app.
Open registration returns the same 201 acceptance without cookies for both new
and claimed addresses, including uniqueness races. The existing registration
client follows acceptance with password login. Login uses a dummy bcrypt comparison for absent accounts and a uniform error
for absent, disabled, invalid-password and missing-membership accounts.
