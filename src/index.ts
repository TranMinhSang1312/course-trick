import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomToken, sha256Hex, signAccessToken, verifyAccessToken } from "./crypto";
import { createPaymentLink, verifyPayOsWebhook } from "./payos";
import type { Env, PayOsWebhookBody } from "./types";

type Variables = { entitlement: EntitlementToken };
type EntitlementToken = { sub: string; licenseId: string; plan: string; exp: number };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("/v1/*", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization"] }));

app.get("/health", (c) => c.json({ ok: true, service: "coursera-tool-api" }));

app.post("/v1/orders", async (c) => {
  const body: { buyerEmail?: string } = await c.req
    .json<{ buyerEmail?: string }>()
    .catch(() => ({}));
  const buyerEmail = body.buyerEmail?.trim().toLowerCase();
  if (!buyerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(buyerEmail)) {
    return c.json({ error: "A valid buyerEmail is required" }, 400);
  }

  const amount = Number.parseInt(c.env.PRODUCT_PRICE_VND, 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) return c.json({ error: "Server price is invalid" }, 500);

  const orderCode = Date.now();
  const description = `EXT${orderCode.toString().slice(-6)}`;
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO orders (order_code, buyer_email, amount, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(orderCode, buyerEmail, amount, now)
    .run();

  try {
    const payment = await createPaymentLink(c.env, { orderCode, amount, description, buyerEmail });
    await c.env.DB.prepare("UPDATE orders SET payment_link_id = ? WHERE order_code = ?")
      .bind(payment.paymentLinkId, orderCode)
      .run();
    return c.json({ orderCode, amount, currency: "VND", ...payment }, 201);
  } catch (error) {
    await c.env.DB.prepare("UPDATE orders SET status = 'CANCELLED' WHERE order_code = ?")
      .bind(orderCode)
      .run();
    console.error(error);
    return c.json({ error: "Unable to create payment" }, 502);
  }
});

app.get("/v1/orders/:orderCode", async (c) => {
  const orderCode = Number(c.req.param("orderCode"));
  if (!Number.isSafeInteger(orderCode)) return c.json({ error: "Invalid order code" }, 400);
  const order = await c.env.DB.prepare(
    "SELECT order_code, amount, currency, status, created_at, paid_at FROM orders WHERE order_code = ?",
  )
    .bind(orderCode)
    .first();
  return order ? c.json(order) : c.json({ error: "Order not found" }, 404);
});

app.post("/v1/webhooks/payos", async (c) => {
  const body = await c.req.json<PayOsWebhookBody>().catch(() => null);
  if (!body || !(await verifyPayOsWebhook(body, c.env.PAYOS_CHECKSUM_KEY))) {
    return c.json({ error: "Invalid signature" }, 400);
  }

  const data = body.data;
  const eventKey = `${data.paymentLinkId}:${data.reference}`;
  const existingEvent = await c.env.DB.prepare("SELECT id FROM payment_events WHERE event_key = ?")
    .bind(eventKey)
    .first();
  if (existingEvent) return c.json({ success: true });

  const order = await c.env.DB.prepare(
    "SELECT order_code, buyer_email, amount, status FROM orders WHERE order_code = ?",
  )
    .bind(data.orderCode)
    .first<{ order_code: number; buyer_email: string; amount: number; status: string }>();
  if (!order || order.amount !== data.amount) return c.json({ error: "Order mismatch" }, 409);

  const now = new Date().toISOString();
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO payment_events (event_key, order_code, payload, received_at) VALUES (?, ?, ?, ?)",
    ).bind(eventKey, data.orderCode, JSON.stringify(body), now),
  ];

  if (body.success && data.code === "00" && order.status !== "PAID") {
    const licenseId = crypto.randomUUID();
    const licenseKey = randomToken("ct");
    const licenseHash = await sha256Hex(licenseKey);
    const maxActivations = Math.max(1, Number.parseInt(c.env.LICENSE_MAX_ACTIVATIONS, 10) || 3);
    statements.push(
      c.env.DB.prepare(
        "UPDATE orders SET status = 'PAID', payment_reference = ?, paid_at = ? WHERE order_code = ?",
      ).bind(data.reference, now, data.orderCode),
      c.env.DB.prepare(
        "INSERT INTO licenses (id, license_key_hash, order_code, buyer_email, max_activations, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(licenseId, licenseHash, data.orderCode, order.buyer_email, maxActivations, now),
    );

    // A real product should deliver this once through an authenticated customer portal or email.
    console.log(JSON.stringify({ event: "license.created", orderCode: data.orderCode, licenseKey }));
  }

  await c.env.DB.batch(statements);
  return c.json({ success: true });
});

app.post("/v1/licenses/activate", async (c) => {
  const body: { licenseKey?: string; installationId?: string } = await c.req
    .json<{ licenseKey?: string; installationId?: string }>()
    .catch(() => ({}));
  if (!body.licenseKey || !body.installationId) {
    return c.json({ error: "licenseKey and installationId are required" }, 400);
  }

  const [licenseHash, installationHash] = await Promise.all([
    sha256Hex(body.licenseKey),
    sha256Hex(body.installationId),
  ]);
  const license = await c.env.DB.prepare(
    "SELECT id, plan, status, max_activations, expires_at FROM licenses WHERE license_key_hash = ?",
  )
    .bind(licenseHash)
    .first<{
      id: string;
      plan: string;
      status: string;
      max_activations: number;
      expires_at: string | null;
    }>();
  if (!license || license.status !== "ACTIVE") return c.json({ error: "Invalid license" }, 401);
  if (license.expires_at && Date.parse(license.expires_at) <= Date.now()) {
    return c.json({ error: "License expired" }, 401);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id FROM license_activations WHERE license_id = ? AND installation_hash = ?",
  )
    .bind(license.id, installationHash)
    .first();
  if (!existing) {
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM license_activations WHERE license_id = ?",
    )
      .bind(license.id)
      .first<{ count: number }>();
    if ((count?.count ?? 0) >= license.max_activations) {
      return c.json({ error: "Activation limit reached" }, 409);
    }
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO license_activations (license_id, installation_hash, created_at, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (license_id, installation_hash) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  )
    .bind(license.id, installationHash, now, now)
    .run();

  const exp = Math.floor(Date.now() / 1000) + 60 * 60;
  const accessToken = await signAccessToken(
    { sub: installationHash, licenseId: license.id, plan: license.plan, exp },
    c.env.TOKEN_SIGNING_SECRET,
  );
  return c.json({ active: true, plan: license.plan, features: ["premium"], exp, accessToken });
});

app.use("/v1/entitlements/*", async (c, next) => {
  const authorization = c.req.header("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const payload = await verifyAccessToken<EntitlementToken>(token, c.env.TOKEN_SIGNING_SECRET);
  if (!payload) return c.json({ error: "Unauthorized" }, 401);
  c.set("entitlement", payload);
  await next();
});

app.get("/v1/entitlements/me", async (c) => {
  const entitlement = c.get("entitlement");
  const license = await c.env.DB.prepare("SELECT status, plan, expires_at FROM licenses WHERE id = ?")
    .bind(entitlement.licenseId)
    .first<{ status: string; plan: string; expires_at: string | null }>();
  const active = Boolean(
    license?.status === "ACTIVE" &&
      (!license.expires_at || Date.parse(license.expires_at) > Date.now()),
  );
  return c.json({ active, plan: license?.plan ?? null, features: active ? ["premium"] : [] });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;

