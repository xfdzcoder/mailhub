# Rule regular expressions

Rules use RE2JS 2.9.1 for case-insensitive substring matching. Anchors retain their
usual meaning. Patterns are not lowercased, so escaped character classes keep
their meaning. The application does not fall back to native JavaScript RegExp.

New or edited patterns must use supported RE2 syntax and fit within 1,024 UTF-16
code units. Rules contain at most 50 criteria. Unsupported constructs such as
backreferences and lookahead are rejected by the create, update and test APIs.
Compiled expressions use a bounded 128-entry cache. Matching inputs over 1,000,000
UTF-16 code units are skipped without truncation; the rule test API rejects
oversized subject/body/sender inputs with an explicit error. These are rule
execution budgets, not general message-storage or HTTP-body limits.

Existing incompatible rules remain stored for review, but their effective active
state is false. The list/detail API includes a validationError, and the settings
page shows a paused explanation. The whole rule is excluded from automatic
matching, including ANY rules with another matching condition. Manual execution
and re-enabling are rejected until the expression is corrected. Operators can
still edit or delete the stored rule. No SQL migration or automatic expression
rewrite is performed. Ordinary non-regex operators continue to work.

Before deployment, review any existing expressions that use JavaScript-specific
syntax and edit them into supported syntax. Test representative messages before
running a rule against historical mail. No historical rule run is automatic.

The preferred recovery is to pause incompatible expressions and keep ordinary
rules available. Reverting to unrestricted native regex execution is not a safe
compatibility workaround. CI includes API and evaluation regression coverage; UI
screenshots use synthetic fixtures rather than real mail or user data.
