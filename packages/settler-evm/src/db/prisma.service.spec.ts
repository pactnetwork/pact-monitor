import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrismaService } from './prisma.service';

describe('PrismaService orphan tracker', () => {
  let svc: PrismaService;
  let createMany: ReturnType<typeof vi.fn>;
  let updateMany: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    svc = new PrismaService();
    createMany = vi.fn().mockResolvedValue({ count: 0 });
    updateMany = vi.fn().mockResolvedValue({ count: 0 });
    // Avoid touching a real DB — stub the delegate.
    (svc as unknown as { failedSettlement: unknown }).failedSettlement = {
      createMany,
      updateMany,
    };
  });

  it('recordOrphans writes one row per call with settled:false', async () => {
    await svc.recordOrphans([
      { callId: '0xaa', evidenceRootHash: '0xrh1' },
      { callId: '0xbb', evidenceRootHash: '0xrh2' },
    ]);
    expect(createMany).toHaveBeenCalledOnce();
    const arg = createMany.mock.calls[0][0];
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0]).toMatchObject({
      callId: '0xaa',
      evidenceRootHash: '0xrh1',
      settled: false,
    });
  });

  it('markSettled flips only unsettled rows for the given callIds', async () => {
    await svc.markSettled(['0xaa', '0xbb']);
    expect(updateMany).toHaveBeenCalledWith({
      where: { callId: { in: ['0xaa', '0xbb'] }, settled: false },
      data: { settled: true },
    });
  });

  it('markFailed stamps the error but leaves settled:false', async () => {
    await svc.markFailed(['0xaa'], 'DuplicateCallId');
    expect(updateMany).toHaveBeenCalledWith({
      where: { callId: { in: ['0xaa'] }, settled: false },
      data: { errorMessage: 'DuplicateCallId' },
    });
  });

  it('short-circuits on empty input (no DB call)', async () => {
    await svc.recordOrphans([]);
    await svc.markSettled([]);
    await svc.markFailed([], 'x');
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
