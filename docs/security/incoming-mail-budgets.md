# Incoming message and attachment budgets (#46)

This extends the outgoing foundation in #23 / #48. It does not complete the
original resource-budget project: queue admission/fairness remains #47. The
shared HTTP egress approval policy is unchanged.

Limits are fixed in `src/lib/email/incoming-budget.ts`:

| Resource | Limit |
| --- | --- |
| Raw RFC822 message | 32 MiB |
| Individual decoded/downloaded attachment, including historical local files | 20 MiB |
| Provider JSON response, measured after HTTP decompression | 48 MiB |
| MIME decoding/derived content work | 48 MiB |
| IMAP protocol line / literal / assembled response | 1 MiB / 32 MiB + 1 byte / 48 MiB |
| MIME/provider attachment traversal nodes | 256 |
| Stream read, IMAP download setup, MIME worker | 30 seconds each |
| MIME worker V8 heap | 128 MiB old + 16 MiB young; 4 MiB stack |

Counters use actual chunks before retaining them. Declared MIME sizes,
Content-Length and database sizeBytes do not authorize allocations. ImapFlow protocol limits also cap actual assembled response bytes and lines,
including compressed transport output. Gmail
base64 decoded length is checked before Buffer allocation. IMAP fetches metadata
first, then downloads only missing messages through measured streams rather
than accumulating full message sources in a batch. Download's own limit is set
to budget + 1 so truncation at the policy boundary is detected as overflow.

MIME parsing runs in a disposable worker. A pinned-mailparser adapter gates
transfer decoder and charset decoder output before mailparser's internal text
accumulator. Attachments are collected through measured streams. The aggregate
work counter conservatively counts decoding stages, generated text/HTML, and
each CID data URL expansion, including repeated references. A message can
therefore hit the work limit with fewer than 48 MiB of final content. Worker
memory exhaustion, malformed input, excess nodes and timeout fail the item;
workers are terminated in finally on success and failure. Parser upgrades must
revalidate the decoder adapter. Archives attached to mail are not decompressed.

Read cleanup destroys file/provider streams; HTTP response readers are cancelled
and unlocked even on invalid JSON. Retry responses are cancelled instead of
being drained into strings. Gmail fetch attempts also have a 30-second network
deadline. IMAP setup timeout/cancellation closes the connection and destroys a
late stream; attachment mailbox locks release in finally. Request aborts reach
local reads and attachment provider operations. Failed ingestion uses the existing
failure path rather than persisting partial content.

## Historical policy

Existing mail and attachment rows/files are preserved. A local file is read
through the same 20 MiB measured policy, irrespective of stored metadata.
Oversized downloads return HTTP 413 with instructions to export through the mail
provider. There is no application bypass or silent deletion. Missing files retain
the existing provider recovery behavior; oversized files do not trigger fallback.
Authorization checks still run before any attachment read.

## Validation and synthetic resource evidence

Fixtures in `incoming-budget.test.ts` cover real disposable files, a sparse
oversized historical file, dishonest Content-Length, overflow cancellation,
malformed JSON, base64 MIME, CID rendering, decoded attachment overflow, excess
multipart nodes, active worker cancellation, read timeout and late IMAP setup
cleanup. A disposable loopback HTTP server supplies gzip content to exercise
actual decompressed response limits. Existing provider/authorization tests and
#48 outgoing regressions are included in the full suite.

A standalone Node v24.22.2 / tsx synthetic run on this agent sequentially rejected
an endless 64 KiB chunk source at the 20 MiB attachment boundary and a base64
MIME attachment decoding to 20 MiB + 1 byte (27,962,105 raw bytes). The producer
had emitted 21,102,592 bytes including stream prefetch when destroyed. Both
operations completed in 296 ms; `process.resourceUsage().maxRSS` reported
324,172 KiB peak RSS for the process including its MIME worker; final RSS was
266,162,176 bytes. These are actual one-run synthetic measurements, not a memory
ceiling or a production throughput claim. V8 worker heap limits do not bound all
external Buffer memory; raw/decoded counters bound those separately. Stream
prefetch and a source's current chunk can exist outside the retained-byte budget.

No live Gmail/IMAP accounts or production storage were used. Controlled client
fixtures cover provider setup/download behavior; live provider interoperability,
Redis/Postgres service integration and deployment behavior are not claimed.

Final validation on Node v24.22.2: lint passed with 0 errors (83 warnings),
full Jest run passed 118 suites / 860 tests, TypeScript `--noEmit` passed, and
Next.js production build passed. Two opt-in Redis suites / 11 tests were skipped:
this image has neither redis-server nor Docker. The standalone build includes
mailparser's external runtime module for worker resolution. No UI preview was
created because these changes affect backend resource handling and API errors.
