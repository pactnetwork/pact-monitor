import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import * as request from "supertest";
import { EventsController } from "../src/events/events.controller";
import { EventsService } from "../src/events/events.service";
import { PushSecretGuard } from "../src/guards/push-secret.guard";

const PUSH_SECRET = "test-secret-123";

const makePayload = (callId = "call-001") => ({
  signature: "sig111",
  batchSize: 1,
  totalPremiumsLamports: "500",
  totalRefundsLamports: "0",
  ts: new Date().toISOString(),
  calls: [
    {
      callId,
      agentPubkey: "AgentPubkey1111111111111111111111111111111111",
      endpointSlug: "helius",
      premiumLamports: "500",
      refundLamports: "0",
      latencyMs: 120,
      breach: false,
      ts: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      signature: "sig111",
    },
  ],
});

describe("EventsController", () => {
  let app: INestApplication;
  const mockIngest = jest.fn().mockResolvedValue({ accepted: 1 });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      controllers: [EventsController],
      providers: [
        { provide: EventsService, useValue: { ingest: mockIngest } },
        PushSecretGuard,
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    process.env.INDEXER_PUSH_SECRET = PUSH_SECRET;
    mockIngest.mockClear();
  });

  it("POST /events without bearer returns 401", async () => {
    await request(app.getHttpServer())
      .post("/events")
      .send(makePayload())
      .expect(401);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("POST /events with wrong bearer returns 401", async () => {
    await request(app.getHttpServer())
      .post("/events")
      .set("Authorization", "Bearer wrong-secret")
      .send(makePayload())
      .expect(401);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("POST /events with valid bearer returns 200 and accepted count", async () => {
    const res = await request(app.getHttpServer())
      .post("/events")
      .set("Authorization", `Bearer ${PUSH_SECRET}`)
      .send(makePayload())
      .expect(200);
    expect(res.body).toEqual({ accepted: 1 });
    expect(mockIngest).toHaveBeenCalledTimes(1);
  });

  it("POST /events idempotent — service called but returns accepted:0 for duplicate", async () => {
    mockIngest.mockResolvedValueOnce({ accepted: 0 });
    const res = await request(app.getHttpServer())
      .post("/events")
      .set("Authorization", `Bearer ${PUSH_SECRET}`)
      .send(makePayload("call-001"))
      .expect(200);
    expect(res.body).toEqual({ accepted: 0 });
  });
});
