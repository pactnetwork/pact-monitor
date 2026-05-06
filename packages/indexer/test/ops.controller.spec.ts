import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, UnauthorizedException } from "@nestjs/common";
import * as request from "supertest";
import { OpsController } from "../src/ops/ops.controller";
import { OpsDisabledInProdGuard } from "../src/ops/ops-disabled-in-prod.guard";
import { OpsService } from "../src/ops/ops.service";

describe("OpsController", () => {
  let app: INestApplication;
  const originalNodeEnv = process.env.NODE_ENV;
  const mockVerify = jest.fn();
  const mockPauseTx = jest.fn().mockResolvedValue("dW5zaWduZWQ=");
  const mockUpdateConfigTx = jest.fn().mockResolvedValue("dW5zaWduZWQ=");
  const mockTopupTx = jest.fn().mockResolvedValue("dW5zaWduZWQ=");
  const mockUpdateFeeRecipientsTx = jest
    .fn()
    .mockResolvedValue("dW5zaWduZWQ=");

  beforeAll(async () => {
    // OpsDisabledInProdGuard 404s when NODE_ENV=production. Force a non-prod
    // value so these tests exercise the controller logic, not the prod gate.
    process.env.NODE_ENV = "test";
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OpsController],
      providers: [
        OpsDisabledInProdGuard,
        {
          provide: OpsService,
          useValue: {
            verifyOperator: mockVerify,
            buildPauseEndpointTx: mockPauseTx,
            buildUpdateConfigTx: mockUpdateConfigTx,
            buildTopupTx: mockTopupTx,
            buildUpdateFeeRecipientsTx: mockUpdateFeeRecipientsTx,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env.NODE_ENV = originalNodeEnv;
  });
  beforeEach(() => {
    mockVerify.mockReset();
    mockPauseTx.mockClear();
    mockUpdateConfigTx.mockClear();
    mockTopupTx.mockClear();
    mockUpdateFeeRecipientsTx.mockClear();
  });

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
    mockVerify.mockRejectedValue(
      new UnauthorizedException("Pubkey not in operator allowlist"),
    );
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
    mockVerify.mockRejectedValue(
      new UnauthorizedException("Signature verification failed"),
    );
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

  it("POST /api/ops/topup forwards slug + amount to the service", async () => {
    mockVerify.mockResolvedValue(undefined);
    await request(app.getHttpServer())
      .post("/api/ops/topup")
      .send({
        signerPubkey: "ValidPubkey1111111111111111111111111111111111",
        message: "topup:helius:1000000",
        signature: "sigBase58",
        slug: "helius",
        amountLamports: "1000000",
      })
      .expect(200);
    expect(mockTopupTx).toHaveBeenCalledWith("helius", "1000000");
  });

  it("POST /api/ops/update-fee-recipients with allowlisted signer returns unsignedTx", async () => {
    mockVerify.mockResolvedValue(undefined);
    const recipients = [
      {
        kind: 0,
        pubkey: "TreasuryPubkey11111111111111111111111111111",
        bps: 8000,
      },
      {
        kind: 1,
        pubkey: "AffiliateA111111111111111111111111111111111",
        bps: 2000,
      },
    ];
    const res = await request(app.getHttpServer())
      .post("/api/ops/update-fee-recipients")
      .send({
        signerPubkey: "ValidPubkey1111111111111111111111111111111111",
        message: "update_fee_recipients:v1",
        signature: "sigBase58",
        recipients,
      })
      .expect(200);
    expect(res.body).toHaveProperty("unsignedTx");
    expect(mockUpdateFeeRecipientsTx).toHaveBeenCalledWith(recipients);
  });

  it("POST /api/ops/update-fee-recipients without allowlist returns 401", async () => {
    mockVerify.mockRejectedValue(
      new UnauthorizedException("Pubkey not in operator allowlist"),
    );
    await request(app.getHttpServer())
      .post("/api/ops/update-fee-recipients")
      .send({
        signerPubkey: "UnknownPubkey1111111111111111111111111111111",
        message: "update_fee_recipients:v1",
        signature: "sigBase58",
        recipients: [],
      })
      .expect(401);
  });
});
