// Synthetic crash/restart fixture: called only by the isolated integration suite.
import { claimSend, reconcileSendOperations } from '../../src/lib/workload/send-once';
import { withWork } from '../../src/lib/workload/admission';
import { prisma } from '../../src/lib/db/prisma';

async function main() {
  const url = new URL(process.env.WORKLOAD_TEST_DATABASE_URL || '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.endsWith('_test') || process.env.DATABASE_URL !== url.toString()) throw new Error('Disposable loopback *_test database required');
  const [mode, organizationId, userId, accountId, operationKey] = process.argv.slice(2);
  if (mode === 'expire-preparation') await prisma.sendOperation.updateMany({ where: { organizationId, state: 'PREPARING' }, data: { preparationExpiresAt: new Date(0) } });
  else if (mode === 'cleanup') await prisma.sendOperation.deleteMany({ where: { organizationId } });
  else if (mode === 'inspect') console.log(JSON.stringify(await prisma.sendOperation.findMany({ where: { organizationId }, select: { operationKey: true, state: true } })));
  else if (mode === 'maintenance') await reconcileSendOperations();
  else {
    await withWork({ organizationId, userId }, async () => {
      const operation = await claimSend({ organizationId, userId }, accountId, operationKey, { subject: 'Synthetic restart fixture' });
      if (mode === 'delivery') await operation.beforeDelivery();
      // Deliberately bypass send callbacks and admission finally/release, like a crash.
      process.exit(0);
    });
  }
}
main().then(() => process.exit(0)).catch(async error => {
  console.error(error instanceof Error ? error.message : String(error));
  await prisma.$disconnect();
  process.exit(1);
});
