// These fixtures exercise mailbox behavior; admission has isolated Redis integration coverage.
jest.mock('@/lib/workload/admission', () => ({
  withWork: async (_owner: unknown, run: () => Promise<unknown>) => run(),
  AdmissionError: class extends Error {},
}));
jest.mock('@/lib/workload/ownership', () => ({
  accountWorkOwner: async () => ({ userId: 'fixture-user', organizationId: 'fixture-org' }),
}));
jest.mock('@/lib/redis', () => ({
  redis: { publish: jest.fn() },
}));

jest.mock('@/lib/queue/client', () => ({
  searchQueue: { add: jest.fn() },
}));

import type { GmailMessagePart } from '@/lib/gmail/api';
import { extractGmailAttachmentReferences } from '@/lib/gmail/sync-manager';

describe('extractGmailAttachmentReferences', () => {
  it('returns Gmail attachment IDs in payload order', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'a.pdf',
          body: { attachmentId: 'gmail-att-1' },
        },
      ],
    };

    expect(
      extractGmailAttachmentReferences(payload)
    ).toEqual([{ ordinal: 0, gmailAttachmentId: 'gmail-att-1' }]);
  });

  it('persists an ordinal-only reference for inline content', () => {
    expect(
      extractGmailAttachmentReferences({
        mimeType: 'multipart/related',
        parts: [
          {
            filename: 'inline.png',
            mimeType: 'image/png',
            headers: [{ name: 'Content-ID', value: '<image-1>' }],
            body: { data: 'aW5saW5l' },
          },
        ],
      })
    ).toEqual([{ ordinal: 0, gmailAttachmentId: null }]);
  });
});
