jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn(),
  unlink: jest.fn().mockResolvedValue(undefined),
}));
import { writeFile, unlink } from 'fs/promises';
import { stageOutgoingFiles } from '@/lib/email/outgoing-files';
import { validateOutgoingMail } from '@/lib/email/outgoing-budget';

test('removes successful and partially written staging files after a later write fails', async () => {
  (writeFile as jest.Mock).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full'));
  const att = { filename: 'x', contentType: 'application/octet-stream', content: 'YWJj' };
  await expect(stageOutgoingFiles([att, att])).rejects.toThrow('disk full');
  expect(writeFile).toHaveBeenCalledTimes(2);
  expect(unlink).toHaveBeenCalledTimes(2);
  for (const call of (writeFile as jest.Mock).mock.calls) expect(unlink).toHaveBeenCalledWith(call[0]);
});

test('rejects noncanonical padding before any Buffer decoding', () => {
  const from = jest.spyOn(Buffer, 'from');
  try {
    expect(() => validateOutgoingMail({ attachments: [{ filename: 'x', contentType: 'text/plain', content: 'Zh==' }] })).toThrow('canonical');
    expect(from).not.toHaveBeenCalled();
  } finally { from.mockRestore(); }
});

test('validates the default 16 MiB decoded aggregate without allocating decoded buffers', () => {
  const content = Buffer.alloc(8 * 1024 * 1024, 120).toString('base64');
  const att = { filename: 'synthetic.bin', contentType: 'application/octet-stream', content };
  const from = jest.spyOn(Buffer, 'from');
  try {
    validateOutgoingMail({ attachments: [att, att] });
    expect(from).not.toHaveBeenCalled();
  } finally { from.mockRestore(); }
});
