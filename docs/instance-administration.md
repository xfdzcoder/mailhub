# Instance-wide preferences

Instance preferences affect all organizations. Access to both the read and update
API requires the authenticated user ID to appear in the deployment-managed
`INSTANCE_ADMIN_USER_IDS` comma-separated list, and the caller must currently be
an administrator of the organization in their session. Matching uses complete IDs;
there are no wildcard, email-domain, first-user, or automatic signup grants.

The default is an empty list, which denies API access to global settings. Existing
global settings and organization/personal preferences remain stored and unchanged.
Organization administrators retain their organization-scoped settings access.

Before upgrading, an instance operator should identify the intended existing user
IDs from their trusted administration records or database, provision the exact IDs
in the server environment, and restart the Web service. Never put private IDs or
secrets in public source or NEXT_PUBLIC variables. No database migration is needed.

To remove instance access, update the server configuration and restart the Web
service. Current membership is checked for every global-settings request, so a
removed or demoted organization administrator is denied even with an old role
claim. This change is specific to instance settings; general session revocation
is a separate task.

If provisioning is unavailable or an upgrade needs investigation, leave the list
empty and preserve existing preferences. Do not restore access for every tenant
administrator as a workaround.
