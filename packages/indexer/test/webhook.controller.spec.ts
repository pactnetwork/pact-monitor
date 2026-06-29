import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, UnauthorizedException } from "@nestjs/common";
import request from "supertest";
import { WebhookController } from "../src/webhook/webhook.controller";
import { WebhookParserService } from "../src/webhook/parser.service";

const HELIUS_SECRET = "helius-secret-abc";

describe("WebhookController", () => {
  let app: INestApplication;
  const mockParse = jest.fn().mockReturnValue({ received: true });

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: WebhookParserService, useValue: { parse: mockParse } },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    mockParse.mockClear();
    mockParse.mockReturnValue({ received: true });
  });

  describe("when HELIUS_WEBHOOK_SECRET is set", () => {
    beforeEach(() => {
      process.env.HELIUS_WEBHOOK_SECRET = HELIUS_SECRET;
    });

    afterEach(() => {
      delete process.env.HELIUS_WEBHOOK_SECRET;
    });

    it("POST /webhook/helius with valid bearer returns 201 and parser result", async () => {
      const res = await request(app.getHttpServer())
        .post("/webhook/helius")
        .set("Authorization", `Bearer ${HELIUS_SECRET}`)
        .send({ type: "TRANSFER" })
        .expect(201);
      expect(res.body).toEqual({ received: true });
      expect(mockParse).toHaveBeenCalledTimes(1);
    });

    it("POST /webhook/helius with wrong bearer returns 401", async () => {
      await request(app.getHttpServer())
        .post("/webhook/helius")
        .set("Authorization", "Bearer wrong-secret")
        .send({ type: "TRANSFER" })
        .expect(401);
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("POST /webhook/helius with missing authorization returns 401", async () => {
      await request(app.getHttpServer())
        .post("/webhook/helius")
        .send({ type: "TRANSFER" })
        .expect(401);
      expect(mockParse).not.toHaveBeenCalled();
    });

    it("POST /webhook/helius forwards the raw body to the parser", async () => {
      const payload = { type: "TRANSFER", amount: 1000 };
      await request(app.getHttpServer())
        .post("/webhook/helius")
        .set("Authorization", `Bearer ${HELIUS_SECRET}`)
        .send(payload)
        .expect(201);
      expect(mockParse).toHaveBeenCalledWith(expect.objectContaining({ type: "TRANSFER", amount: 1000 }));
    });

    it("POST /webhook/helius with malformed JSON body still calls parser (controller does not validate shape)", async () => {
      // NestJS parses body as plain object; an empty object is valid unknown
      await request(app.getHttpServer())
        .post("/webhook/helius")
        .set("Authorization", `Bearer ${HELIUS_SECRET}`)
        .set("Content-Type", "application/json")
        .send("{}")
        .expect(201);
      expect(mockParse).toHaveBeenCalledTimes(1);
    });
  });

  describe("when HELIUS_WEBHOOK_SECRET is not set (open endpoint)", () => {
    beforeEach(() => {
      delete process.env.HELIUS_WEBHOOK_SECRET;
    });

    it("POST /webhook/helius without authorization header is accepted", async () => {
      const res = await request(app.getHttpServer())
        .post("/webhook/helius")
        .send({ type: "TRANSFER" })
        .expect(201);
      expect(res.body).toEqual({ received: true });
      expect(mockParse).toHaveBeenCalledTimes(1);
    });

    it("POST /webhook/helius with any bearer is accepted when secret not configured", async () => {
      const res = await request(app.getHttpServer())
        .post("/webhook/helius")
        .set("Authorization", "Bearer anything-goes")
        .send({ type: "TRANSFER" })
        .expect(201);
      expect(res.body).toEqual({ received: true });
    });
  });
});
