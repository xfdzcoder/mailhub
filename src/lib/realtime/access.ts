import { accountAccessWhere, type AccountAuth } from '@/lib/accounts/access';
import { prisma } from '@/lib/db/prisma';

export async function loadAccessibleRealtimeAccountIds(
  auth: AccountAuth
): Promise<Set<string>> {
  const accounts = await prisma.emailAccount.findMany({
    where: accountAccessWhere(auth),
    select: { id: true },
  });

  return new Set(accounts.map(({ id }) => id));
}

export function formatAccessibleSseMessage(
  message: string,
  accessibleAccountIds: ReadonlySet<string>
): string | null {
  try {
    const parsed = JSON.parse(message) as {
      event?: unknown;
      accountId?: unknown;
    };

    if (
      typeof parsed.accountId !== 'string' ||
      !accessibleAccountIds.has(parsed.accountId)
    ) {
      return null;
    }

    if (!['new_email', 'initial_sync_complete', 'sync_progress'].includes(String(parsed.event))) {
      return null;
    }

    // Events invalidate client queries; mail contents and producer metadata are private.
    return `event: ${parsed.event}\ndata: ${JSON.stringify({ accountId: parsed.accountId })}\n\n`;
  } catch {
    return null;
  }
}
