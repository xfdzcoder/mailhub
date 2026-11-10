# Outgoing mail budgets

These per-operation limits cover POST `/api/accounts/[id]/emails/send`, PUT
`/api/accounts/[id]/drafts`, POST `/api/accounts/[id]/drafts/sync`, and POST
`/api/ai/draft`. The exported SMTP sender (including the rules engine caller)
and Graph sender validate the same message budget before decoding or delivery.
Gmail raw send/draft helpers additionally reject oversized RFC822 buffers before
base64url encoding. There is no bulk send endpoint. Draft sync accepts only a
bounded draft ID; it validates stored bodies, recipient headers, attachment count,
and actual disk bytes before composing or uploading. It does not delete oversized
historical messages. Incoming attachment retrieval, MIME parsing, distributed
admission, and storage retention remain separate work (#46/#47).

`ComposeModal` prepares browser FileReader base64 for send/autosave and reloads
existing draft attachments through the retrieval API; neither browser metadata nor
its `sizeBytes` is trusted. Both server destinations validate the full collection.
The only production `sendEmail` callers are the send route and rules engine; the
only raw Gmail callers are that sender and draft sync. Incoming
`reconcileAttachmentFiles`/provider attachment decoding and attachment download
are retrieval paths, excluded from this outgoing-only policy.

All settings are optional environment variables. Values must be decimal positive
safe integers, at most the default shown below. Operators can lower limits; zero,
empty strings, signs, fractions, Infinity and oversized values are configuration
errors, never an instruction to disable protection. Configuration is checked on
every budget entry, including direct helper calls. Invalid configuration fails the
operation rather than silently using a fallback. Settings should be applied to all
web/worker processes consistently.

| Variable | Default | Unit / scope |
| --- | ---: | --- |
| OUTGOING_REQUEST_BYTES | 25165824 | actual streamed JSON bytes (24 MiB) |
| OUTGOING_ATTACHMENT_BYTES | 8388608 | decoded bytes per attachment (8 MiB) |
| OUTGOING_TOTAL_ATTACHMENT_BYTES | 16777216 | sum of decoded attachment bytes (16 MiB) |
| OUTGOING_ATTACHMENTS | 32 | attachments per message/draft |
| OUTGOING_RECIPIENTS | 100 | combined To/Cc/Bcc entries |
| OUTGOING_BODY_BYTES | 1048576 | UTF-8 bytes per HTML/plain body or AI input text |
| OUTGOING_HEADER_BYTES | 8192 | UTF-8 bytes per subject, reply/reference header, recipient, filename, content type; per draft recipient string |
| OUTGOING_ARGUMENT_BYTES | 256 | UTF-8 bytes per draft/attachment ID or AI control/context ID |
| OUTGOING_RAW_BYTES | 27262976 | raw Gmail/remote draft RFC822 bytes (26 MiB) |

The JSON reader counts actual chunks, ignoring Content-Length (missing, false or
conflicting). It works with a directly invoked Web Request, with no ingress
assumptions. It rejects overflow with 413, malformed JSON/UTF-8 and aborted input
with 400, and cancels the reader on failure. JSON parsing only starts after EOF
within the cap. The reader uses a geometrically grown buffer bounded by the cap,
so one-byte chunks do not create millions of retained chunk objects. As with any
Web stream consumer, the producer owns allocation of the chunk it delivers.

Attachment validation happens for the whole collection before any decoded Buffer
or file is created. Only standard, padded, canonical base64 is accepted, including
zero unused padding bits; whitespace, URL-safe alphabet, omitted padding and
silently repairable encodings return 422. Empty attachments remain valid. Decoded
length is computed from the encoding, never from client `sizeBytes`; persisted
sizes come from actual bytes. Limit violations return bounded 413 errors without
including submitted content. Server-generated filenames prevent client attachment
IDs from becoming paths or overwriting existing files.

Files are staged sequentially before sending or saving. Failed staging removes
new files, including partially written files. Draft and Sent metadata publication
uses a database transaction, and failure removes staged files. A draft with omitted
attachments preserves them; an explicit empty list clears metadata. Stored draft
sync files are read sequentially through bounded file handles with guaranteed
close, rather than unbounded parallel readFile calls. Missing/unreadable files
produce the existing sync warning instead of uploading an incomplete message.
Confirmed delivery followed by local persistence failure returns success with an
explicit warning and message ID; it never resends automatically. An ambiguous
provider failure is not retried by this implementation.

## Synthetic evidence and limits

Tests use small configured caps, synthetic buffers, a disposable temporary
directory and Nodemailer's in-process stream transport plus Mailparser. They cover
exact limits, aggregate limits, many small attachments, misleading declared sizes,
noncanonical base64, chunked cancellation independent of Content-Length, aborts,
write failure, and binary/UTF-8/Bcc MIME preservation. A disposable loopback SMTP sink also
exercises the actual shared sender without real accounts or mail. That test mocks
only account credentials and host resolution to permit its disposable loopback
sink; production outbound host policy is unchanged. No real mail or deployed
service is used. These are allocation bounds and synthetic functional evidence,
not mailbox-capacity or live-service load measurements. A Buffer.from spy checks
that noncanonical input is rejected before decoding, and that validation of the
full default 16 MiB decoded aggregate performs no Buffer.from decoding. A standalone
Node 24.11.1 synthetic run scanned 22,369,624 encoded bytes (two references to one
8 MiB attachment fixture) with zero base64 Buffer allocations and an observed RSS
delta of zero during validation. This single-process snapshot excludes fixture
creation, request parsing, MIME composition, delivery and concurrent requests; it
is not a peak-memory or capacity measurement.

The defaults allow ordinary messages while keeping attachments well below common
provider message ceilings. Base64 expands 16 MiB to about 21.34 MiB; two 1 MiB bodies
plus JSON overhead must also fit the 24 MiB request cap (not every individually
maximal field can fit simultaneously). A stream buffer is at most 24 MiB; growing
it can temporarily retain the previous buffer (less than another 24 MiB). JSON
text and parsed strings add runtime-dependent copies, while decoded attachments
are bounded to 16 MiB and MIME/base64 encoding adds further copies. Consequently
24 MiB is not a process memory ceiling. No concurrency or total storage capacity
claim is made. Model, notification and Push transport policies and response caps
are unchanged.

## Repository verification

Verified on Node 24.11.1: full Jest run passed (840 passed, 11 skipped), TypeScript
`--noEmit` passed, lint passed (zero errors, 83 warnings), and the standalone
production build passed. The 11 skipped tests belong to the two opt-in isolated
Redis suites; no Redis executable was available in this image. The build logged
connection refusals to local Redis at 127.0.0.1:6379 but completed successfully.
The SMTP/MIME and filesystem checks above ran; a real database transaction rollback
and TLS/provider delivery were not integration-tested. No deployed database,
Redis, provider account, or real mail was used. Incoming and distributed-admission
slices are not implemented by this change.
