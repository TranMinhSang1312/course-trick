import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "../src/crypto";
import { canonicalQuery } from "../src/payos";

describe("canonicalQuery", () => {
  it("sorts payOS signature fields alphabetically", () => {
    expect(canonicalQuery({ orderCode: 2, amount: 1, description: "EXT" })).toBe(
      "amount=1&description=EXT&orderCode=2",
    );
  });
});

describe("access token", () => {
  it("signs and verifies a valid token", async () => {
    const secret = "a-secure-test-secret-that-is-long-enough";
    const token = await signAccessToken(
      { sub: "device", licenseId: "license", plan: "PRO", exp: Math.floor(Date.now() / 1000) + 60 },
      secret,
    );
    const payload = await verifyAccessToken<{ sub: string }>(token, secret);
    expect(payload?.sub).toBe("device");
  });

  it("rejects a modified token", async () => {
    const secret = "a-secure-test-secret-that-is-long-enough";
    const token = await signAccessToken({ sub: "device" }, secret);
    expect(await verifyAccessToken(`${token}x`, secret)).toBeNull();
  });
});

