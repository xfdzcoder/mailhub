# Durable attachment accounting adoption

The #61 foundation is now available on dev. This continuation adopts its contract
for outgoing send/draft writers and reconciliation. See
[the accounting contract](../attachment-accounting.md) and
[follow-up behavior and isolated validation](follow-up-validation.md).

Existing volumes must be inventoried until stable before new writes are admitted.
Unknown ownership, orphan/error observations and incomplete inventory fail closed.
Accounting evidence survives account/email deletion; expiry never authorizes file
deletion. These budgets cover local attachment bytes only. Database/search/WAL
storage and remaining interactive admission coverage are outside this follow-up.
Keep PR #49 draft pending manual dev integration and review.
