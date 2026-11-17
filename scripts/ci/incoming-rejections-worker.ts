// Synthetic, disposable PostgreSQL only. Run `seed`, restart worker/DB, then `verify`.
import assert from 'node:assert/strict';
import { prisma } from '../../src/lib/db/prisma';
import { evaluateIncoming, clearIncomingRejections, cleanupIncomingRejections, imapSource, syncRevision } from '../../src/lib/email/incoming-rejections';
import { IncomingPolicyError } from '../../src/lib/email/incoming-budget';

const accountId = '50000000-0050-4000-8000-000000000001';
const gmail = { accountId, provider: 'gmail' as const, providerMessageId: 'synthetic-worker-rejection' };
const imap = imapSource(accountId, 'Synthetic/Inbox', BigInt(42), BigInt(7))!;
const reject = async () => { throw new IncomingPolicyError('message_size_limit'); };
async function main() {
  assert.equal(process.env.INCOMING_REJECTION_FIXTURE, '1', 'Requires explicit disposable-database fixture opt-in');
  if (process.argv[2] === 'seed') {
    await prisma.$executeRaw`INSERT INTO users(id,email,name,password_hash,updated_at) VALUES (${accountId}::uuid,'worker@example.invalid','Synthetic','unused',now())`;
    await prisma.$executeRaw`INSERT INTO organizations(id,name,slug,updated_at) VALUES (${accountId}::uuid,'Synthetic worker','synthetic-worker-rejections',now())`;
    await prisma.$executeRaw`INSERT INTO organization_members(organization_id,user_id,role) VALUES (${accountId}::uuid,${accountId}::uuid,'admin')`;
    await prisma.$executeRaw`INSERT INTO email_accounts(id,organization_id,owner_user_id,label,email_address,provider,updated_at) VALUES (${accountId}::uuid,${accountId}::uuid,${accountId}::uuid,'Synthetic','worker@example.invalid','imap',now())`;
    for (const source of [gmail, imap]) {
      const outcomes = await Promise.all(Array.from({ length: 4 }, () => evaluateIncoming(source, reject)));
      assert(outcomes.every(outcome => outcome.kind === 'rejected'));
    }
    assert.equal(await prisma.incomingMailRejection.count({ where: { accountId } }), 2);
    console.log('Synthetic concurrent provider rejections persisted; restart worker and PostgreSQL before verify.');
  } else {
    assert.equal(process.argv[2], 'verify');
    for (const source of [gmail, imap]) {
      const before = await prisma.incomingMailRejection.findMany({ where: { accountId }, orderBy: { id: 'asc' } });
      assert.equal((await evaluateIncoming(source, async () => { throw new Error('must suppress after restart'); })).kind, 'rejected');
      assert.deepEqual(await prisma.incomingMailRejection.findMany({ where: { accountId }, orderBy: { id: 'asc' } }), before);
    }
    assert.equal((await evaluateIncoming({ ...gmail, providerMessageId: 'ordinary' }, async () => 'ordinary synthetic message')).kind, 'accepted');
    assert.equal((await evaluateIncoming({ ...imap, uid: BigInt(8) }, async () => 'ordinary synthetic message')).kind, 'accepted');
    // A previous policy must be reevaluated, preserving the initial retention.
    const before = await prisma.incomingMailRejection.findFirstOrThrow({ where: { accountId, provider: 'gmail' } });
    await prisma.incomingMailRejection.update({ where: { id: before.id }, data: { policyVersion: 1 } });
    assert.equal((await evaluateIncoming(gmail, reject)).kind, 'rejected');
    const after = await prisma.incomingMailRejection.findUniqueOrThrow({ where: { id: before.id } });
    assert.equal(after.firstRejectedAt.getTime(), before.firstRejectedAt.getTime());
    assert.equal(after.expiresAt.getTime(), before.expiresAt.getTime());
    await prisma.$executeRaw`UPDATE incoming_mail_rejections SET first_rejected_at=now()-interval '31 days', last_rejected_at=now()-interval '31 days', expires_at=now()-interval '1 day' WHERE account_id=${accountId}::uuid`;
    assert.equal((await evaluateIncoming(gmail, async () => 'expired retry')).kind, 'accepted');
    await cleanupIncomingRejections();
    assert.equal(await prisma.incomingMailRejection.count({ where: { accountId } }), 0);
    // Reset completes while the provider read is still in progress.
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const work = evaluateIncoming(gmail, async () => { entered(); await pending; return reject(); });
    await started;
    const oldAccount = await prisma.emailAccount.findUniqueOrThrow({ where: { id: accountId } });
    await clearIncomingRejections(accountId);
    finish();
    assert.equal((await work).kind, 'retryable');
    await assert.rejects(prisma.emailAccount.update({
      where: { id: accountId, updatedAt: syncRevision(oldAccount.updatedAt) },
      data: { lastSyncedAt: new Date() },
    }));
    const resetAccount = await prisma.emailAccount.findUniqueOrThrow({ where: { id: accountId } });
    assert.equal(resetAccount.lastSyncedAt, null);
    // Current revision remains writable despite PostgreSQL's microsecond precision.
    await prisma.emailAccount.update({
      where: { id: accountId, updatedAt: syncRevision(resetAccount.updatedAt) },
      data: { lastSyncedAt: new Date() },
    });
    assert.equal(await prisma.incomingMailRejection.count({ where: { accountId } }), 0);
    assert.equal((await evaluateIncoming(gmail, async () => 'resync')).kind, 'accepted');
    await prisma.emailAccount.delete({ where: { id: accountId } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: accountId } });
    await prisma.organization.delete({ where: { id: accountId } });
    await prisma.user.delete({ where: { id: accountId } });
    console.log('Durable deduplication, restart, ordinary successors, policy retention, expiry, cleanup and in-flight resync passed.');
  }
}
main().finally(() => prisma.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
