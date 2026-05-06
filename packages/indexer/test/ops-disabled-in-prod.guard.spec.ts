import { ExecutionContext, NotFoundException } from "@nestjs/common";
import { OpsDisabledInProdGuard } from "../src/ops/ops-disabled-in-prod.guard";

describe("OpsDisabledInProdGuard", () => {
  const dummyContext = {} as ExecutionContext;
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("throws NotFoundException when NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    const guard = new OpsDisabledInProdGuard();
    expect(() => guard.canActivate(dummyContext)).toThrow(NotFoundException);
  });

  it("returns true when NODE_ENV=development", () => {
    process.env.NODE_ENV = "development";
    const guard = new OpsDisabledInProdGuard();
    expect(guard.canActivate(dummyContext)).toBe(true);
  });

  it("returns true when NODE_ENV is unset (treated as not-production)", () => {
    delete process.env.NODE_ENV;
    const guard = new OpsDisabledInProdGuard();
    expect(guard.canActivate(dummyContext)).toBe(true);
  });

  it("returns true when NODE_ENV=test", () => {
    process.env.NODE_ENV = "test";
    const guard = new OpsDisabledInProdGuard();
    expect(guard.canActivate(dummyContext)).toBe(true);
  });
});
