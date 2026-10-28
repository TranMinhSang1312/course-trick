import { hmacHex, timingSafeEqualHex } from "./crypto";
import type { Env, PayOsWebhookBody } from "./types";

function signatureValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function canonicalQuery(data: Record<string, unknown>): string {
  return Object.keys(data)
    .sort()
    .map((key) => `${key}=${signatureValue(data[key])}`)
    .join("&");
}

export async function createPaymentLink(
  env: Env,
  input: {
    orderCode: number;
    amount: number;
    description: string;
    buyerEmail: string;
  },
) {
  const signable = {
    amount: input.amount,
    cancelUrl: env.CANCEL_URL,
    description: input.description,
    orderCode: input.orderCode,
    returnUrl: env.RETURN_URL,
  };
  const signature = await hmacHex(env.PAYOS_CHECKSUM_KEY, canonicalQuery(signable));
  const response = await fetch("https://api-merchant.payos.vn/v2/payment-requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": env.PAYOS_CLIENT_ID,
      "x-api-key": env.PAYOS_API_KEY,
    },
    body: JSON.stringify({
      ...signable,
      buyerEmail: input.buyerEmail,
      items: [{ name: "Extension Pro", quantity: 1, price: input.amount }],
      expiredAt: Math.floor(Date.now() / 1000) + 15 * 60,
      signature,
    }),
  });

  const body = (await response.json()) as {
    code?: string;
    desc?: string;
    data?: { paymentLinkId: string; checkoutUrl: string; qrCode: string; status: string };
  };
  if (!response.ok || body.code !== "00" || !body.data) {
    throw new Error(`payOS create payment failed: ${body.desc ?? response.status}`);
  }
  return body.data;
}

export async function verifyPayOsWebhook(
  body: PayOsWebhookBody,
  checksumKey: string,
): Promise<boolean> {
  if (!body.data || !body.signature) return false;
  const expected = await hmacHex(checksumKey, canonicalQuery(body.data));
  return timingSafeEqualHex(expected, body.signature.toLowerCase());
}

