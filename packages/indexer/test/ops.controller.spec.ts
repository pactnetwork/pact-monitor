import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, UnauthorizedException } from "@nestjs/common";
import * as request from "supertest";
import { OpsController } from "../src/ops/ops.controller";
import { OpsService } from "../src/ops/ops.service";

describe("OpsController", () => {
  let app: INestApplication;
  const mockVerify = jest.fn();
  const mockPauseTx = jest.fn().mockResolvedValue("dW5zaWduZWQ=");

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OpsController],
      providers: [
        {
          provide: OpsService,
          useValue: {
            verifyOperator: mockVerify,
            buildPauseEndpointTx: mockPauseTx,
            buildUpdateConfigTx: jest.fn().mockResolvedValue("dW5zaWduZWQ="),
            buildTopupTx: jest.fn().mockResolvedValue("dW5zaWduZWQ="),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => { mockVerify.mockReset(); mockPauseTx.mockClear(); });

  it("POST /api/ops/pause with valid allowlisted signer returns unsignedTx", async () => {
    mockVerify.mockResolvedValue(undefined);
    const res = await request(app.getHttpServer())
      .post("/api/ops/pause")
      .send({
        signerPubkey: "ValidPubkey1111111111111111111111111111111111",
        message: "pause:helius:true",
        signature: "validSigBase58",
        slug: "helius",
        paused: true,
      })
      .expect(200);
    expect(res.body).toHaveProperty("unsignedTx");
    expect(typeof res.body.unsignedTx).toBe("string");
    expect(res.body.unsignedTx.length).toBeGreaterThan(0);
  });

  it("POST /api/ops/pause with pubkey NOT in allowlist returns 401", async () => {
    mockVerify.mockRejectedValue(new UnauthorizedException("Pubkey not in operator allowlist"));
    await request(app.getHttpServer())
      .post("/api/ops/pause")
      .send({
        signerPubkey: "UnknownPubkey1111111111111111111111111111111",
        message: "pause:helius:true",
        signature: "sigBase58",
        slug: "helius",
        paused: true,
      })
      .expect(401);
  });

  it("POST /api/ops/pause with invalid signature returns 401", async () => {
    mockVerify.mockRejectedValue(new UnauthorizedException("Signature verification failed"));
    await request(app.getHttpServer())
      .post("/api/ops/pause")
      .send({
        signerPubkey: "ValidPubkey1111111111111111111111111111111111",
        message: "pause:helius:true",
        signature: "badSig",
        slug: "helius",
        paused: true,
      })
      .expect(401);
  });
});
