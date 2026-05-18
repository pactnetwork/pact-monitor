import { ConfigService } from "@nestjs/config";
import { RefundDeliveryService } from "../src/refund-delivery/refund-delivery.service";
import type { WrapCallEventDto } from "../src/events/events.dto";

function call(id: string, agent: string): WrapCallEventDto {
  return {
    callId: id,
    agentPubkey: agent,
    endpointSlug: "dummy",
    premiumLamports: "100",
    refundLamports: "9000",
    latencyMs: 10,
    outcome: "server_error",
    ts: "2026-05-18T00:00:00.000Z",
    settledAt: "2026-05-18T00:00:06.000Z",
    signature: "SIG",
    shares: [],
  };
}

function svcWith(prisma: unknown): RefundDeliveryService {
  const cfg = { get: () => undefined } as unknown as ConfigService;
  return new RefundDeliveryService(cfg, prisma as never);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("RefundDeliveryService.enqueue", () => {
  it("is a no-op when disabled", async () => {
    const prisma = { agent: { findMany: jest.fn() } };
    const svc = svcWith(prisma);
    svc.onModuleInit(); // WEBHOOK_DELIVERY_ENABLED unset -> disabled
    svc.enqueue([call("c1", "A")]);
    await flush();
    expect(prisma.agent.findMany).not.toHaveBeenCalled();
  });

  it("groups by agent and delivers only to registered agents", async () => {
    const prisma = {
      agent: {
        findMany: jest.fn().mockResolvedValue([
          { pubkey: "A", webhookUrl: "https://a.example.com/h" },
        ]),
        update: jest.fn().mockResolvedValue({ webhookFailCount: 0 }),
      },
    };
    const svc = svcWith(prisma);
    // Force enabled with a stub signer + sender (bypass config/env).
    Object.assign(svc as unknown as Record<string, unknown>, {
      enabled: true,
      signer: { secretKey: new Uint8Array(64), publicKeyBase58: "PUB" },
      maxFailCount: 20,
      sender: { deliver: jest.fn().mockResolvedValue({ ok: true }) },
    });
    const sender = (svc as unknown as { sender: { deliver: jest.Mock } })
      .sender;

    svc.enqueue([call("c1", "A"), call("c2", "A"), call("c3", "B")]);
    await flush();
    await flush();

    expect(prisma.agent.findMany).toHaveBeenCalledWith({
      where: { pubkey: { in: ["A", "B"] }, webhookUrl: { not: null } },
      select: { pubkey: true, webhookUrl: true },
    });
    expect(sender.deliver).toHaveBeenCalledTimes(1); // only A is registered
    const arg = sender.deliver.mock.calls[0][0];
    expect(arg.url).toBe("https://a.example.com/h");
    expect(arg.payload.calls.map((c: { callId: string }) => c.callId)).toEqual([
      "c1",
      "c2",
    ]);
    expect(prisma.agent.update).toHaveBeenCalledWith({
      where: { pubkey: "A" },
      data: { webhookLastDeliveryAt: expect.any(Date), webhookFailCount: 0 },
    });
  });

  it("never throws out of enqueue even if delivery rejects", async () => {
    const prisma = {
      agent: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ pubkey: "A", webhookUrl: "https://a/h" }]),
        update: jest.fn().mockResolvedValue({ webhookFailCount: 1 }),
      },
    };
    const svc = svcWith(prisma);
    Object.assign(svc as unknown as Record<string, unknown>, {
      enabled: true,
      signer: { secretKey: new Uint8Array(64), publicKeyBase58: "PUB" },
      maxFailCount: 20,
      sender: {
        deliver: jest.fn().mockRejectedValue(new Error("boom")),
      },
    });
    expect(() => svc.enqueue([call("c1", "A")])).not.toThrow();
    await flush();
    await flush();
  });
});
