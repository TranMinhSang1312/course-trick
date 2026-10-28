import { Hono } from "hono";
import { cors } from "hono/cors";
import { hmacHex, randomToken, sha256Hex, signAccessToken, verifyAccessToken } from "./crypto";
import { createPaymentLink, verifyPayOsWebhook } from "./payos";
import type { Env, PayOsWebhookBody } from "./types";

type Variables = { entitlement: EntitlementToken };
type EntitlementToken = {
  sub: string;
  licenseId: string;
  activationId: number;
  emailHash: string;
  plan: string;
  exp: number;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("/v1/*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization", "X-Coursera-Email"],
}));

app.get("/health", (c) => c.json({ ok: true, service: "coursera-tool-api" }));

app.get("/payment/success", (c) =>
  c.html(`<!doctype html>
<html lang="vi">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Thanh toán thành công</title></head>
  <body style="font-family:system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem">
    <h1>Đã ghi nhận thanh toán</h1>
    <p>Bạn có thể quay lại extension. Hệ thống sẽ kích hoạt quyền sử dụng sau khi webhook ngân hàng được xác nhận.</p>
  </body>
</html>`),
);

app.get("/payment/cancel", (c) =>
  c.html(`<!doctype html>
<html lang="vi">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Đã hủy thanh toán</title></head>
  <body style="font-family:system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem">
    <h1>Thanh toán chưa hoàn tất</h1>
    <p>Không có quyền premium nào được kích hoạt. Bạn có thể quay lại extension để thử lại.</p>
  </body>
</html>`),
);

app.post("/v1/orders", async (c) => {
  const body: { buyerEmail?: string } = await c.req
    .json<{ buyerEmail?: string }>()
    .catch(() => ({}));
  const buyerEmail = body.buyerEmail?.trim().toLowerCase();
  if (!buyerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(buyerEmail)) {
    return c.json({ error: "A valid buyerEmail is required" }, 400);
  }
  const existingLicense = await c.env.DB.prepare(
    `SELECT id FROM licenses
     WHERE buyer_email = ? AND status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(buyerEmail, new Date().toISOString()).first();
  if (existingLicense) {
    return c.json({ error: "An active license already exists", code: "ACTIVE_LICENSE_EXISTS" }, 409);
  }
  const recentOrder = await c.env.DB.prepare(
    "SELECT order_code FROM orders WHERE buyer_email = ? AND created_at > ? AND status = 'PENDING' LIMIT 1",
  ).bind(buyerEmail, new Date(Date.now() - 60_000).toISOString()).first();
  if (recentOrder) return c.json({ error: "Please wait before creating another order" }, 429);

  const amount = Number.parseInt(c.env.PRODUCT_PRICE_VND, 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) return c.json({ error: "Server price is invalid" }, 500);

  const orderCode = Date.now();
  const description = `EXT${orderCode.toString().slice(-6)}`;
  const now = new Date().toISOString();
  const purchaseToken = randomToken("purchase");
  const purchaseTokenHash = await sha256Hex(purchaseToken);
  await c.env.DB.prepare(
    "INSERT INTO orders (order_code, buyer_email, amount, claim_token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(orderCode, buyerEmail, amount, purchaseTokenHash, now)
    .run();

  try {
    const payment = await createPaymentLink(c.env, { orderCode, amount, description, buyerEmail });
    await c.env.DB.prepare("UPDATE orders SET payment_link_id = ? WHERE order_code = ?")
      .bind(payment.paymentLinkId, orderCode)
      .run();
    return c.json({ orderCode, purchaseToken, amount, currency: "VND", ...payment }, 201);
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
    "SELECT order_code, buyer_email, amount, status, claim_token_hash FROM orders WHERE order_code = ?",
  )
    .bind(data.orderCode)
    .first<{
      order_code: number;
      buyer_email: string;
      amount: number;
      status: string;
      claim_token_hash: string | null;
    }>();
  // payOS validates a webhook URL by sending a correctly signed sample event
  // whose order does not exist in our database. Acknowledge such samples but
  // never create an event, mark an order paid, or issue a license for them.
  if (!order) return c.json({ success: true, acknowledged: "unknown-order" });
  if (order.amount !== data.amount) return c.json({ error: "Order mismatch" }, 409);

  const now = new Date().toISOString();
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO payment_events (event_key, order_code, payload, received_at) VALUES (?, ?, ?, ?)",
    ).bind(eventKey, data.orderCode, JSON.stringify(body), now),
  ];

  if (body.success && data.code === "00" && order.status !== "PAID") {
    const licenseId = crypto.randomUUID();
    if (!order.claim_token_hash) return c.json({ error: "Order has no purchase token" }, 409);
    const maxActivations = Math.max(1, Number.parseInt(c.env.LICENSE_MAX_ACTIVATIONS, 10) || 3);
    const subscriptionDays = Math.max(1, Number.parseInt(c.env.SUBSCRIPTION_DAYS, 10) || 30);
    const expiresAt = new Date(Date.now() + subscriptionDays * 24 * 60 * 60 * 1000).toISOString();
    statements.push(
      c.env.DB.prepare(
        "UPDATE orders SET status = 'PAID', payment_reference = ?, paid_at = ? WHERE order_code = ?",
      ).bind(data.reference, now, data.orderCode),
      c.env.DB.prepare(
        "INSERT INTO licenses (id, license_key_hash, order_code, buyer_email, max_activations, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        licenseId,
        order.claim_token_hash,
        data.orderCode,
        order.buyer_email,
        maxActivations,
        now,
        expiresAt,
      ),
    );
  }

  await c.env.DB.batch(statements);
  return c.json({ success: true });
});

type LicenseRow = {
  id: string;
  buyer_email: string;
  plan: string;
  status: string;
  expires_at: string | null;
  claimed_at: string | null;
};

const normalizeEmail = (value: string | undefined) => value?.trim().toLowerCase() ?? "";
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
const fingerprintEmail = (env: Env, email: string) => {
  if (!env.EMAIL_PEPPER || env.EMAIL_PEPPER.length < 32) {
    throw new Error("EMAIL_PEPPER must contain at least 32 characters");
  }
  return hmacHex(env.EMAIL_PEPPER, normalizeEmail(email));
};
const isLicenseActive = (license: LicenseRow | null) => Boolean(
  license?.status === "ACTIVE" && (!license.expires_at || Date.parse(license.expires_at) > Date.now()),
);

async function issueAccessToken(
  env: Env,
  license: LicenseRow,
  activationId: number,
  installationHash: string,
) {
  const emailHash = await fingerprintEmail(env, license.buyer_email);
  const exp = Math.floor(Date.now() / 1000) + 10 * 60;
  const accessToken = await signAccessToken(
    { sub: installationHash, licenseId: license.id, activationId, emailHash, plan: license.plan, exp },
    env.TOKEN_SIGNING_SECRET,
  );
  return {
    active: true,
    plan: license.plan,
    features: ["premium"],
    expiresAt: license.expires_at,
    emailHash,
    exp,
    accessToken,
  };
}

app.post("/v1/licenses/activate", async (c) => {
  const body: { licenseKey?: string; installationId?: string; courseraEmail?: string } = await c.req
    .json<{ licenseKey?: string; installationId?: string; courseraEmail?: string }>()
    .catch(() => ({}));
  const courseraEmail = normalizeEmail(body.courseraEmail);
  if (!body.licenseKey || !body.installationId || !isEmail(courseraEmail)) {
    return c.json({ error: "licenseKey, installationId and courseraEmail are required" }, 400);
  }

  const [licenseHash, installationHash] = await Promise.all([
    sha256Hex(body.licenseKey),
    sha256Hex(body.installationId),
  ]);
  const license = await c.env.DB.prepare(
    "SELECT id, buyer_email, plan, status, expires_at, claimed_at FROM licenses WHERE license_key_hash = ?",
  ).bind(licenseHash).first<LicenseRow>();
  if (!isLicenseActive(license)) return c.json({ error: "Invalid or expired license" }, 401);
  if (normalizeEmail(license!.buyer_email) !== courseraEmail) {
    return c.json({ error: "Coursera account does not match this purchase" }, 403);
  }

  const existing = await c.env.DB.prepare(
    "SELECT id, revoked_at FROM license_activations WHERE license_id = ? AND installation_hash = ?",
  ).bind(license!.id, installationHash).first<{ id: number; revoked_at: string | null }>();
  const now = new Date().toISOString();
  let activationId: number;
  if (existing && !existing.revoked_at) {
    activationId = existing.id;
  } else {
    const claimed = await c.env.DB.prepare(
      "UPDATE licenses SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL",
    ).bind(now, license!.id).run();
    if ((claimed.meta.changes ?? 0) !== 1) {
      return c.json({ error: "Use account recovery for this installation", code: "RECOVERY_REQUIRED" }, 409);
    }
    await c.env.DB.prepare(
      `INSERT INTO license_activations (license_id, installation_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(license!.id, installationHash, now, now).run();
    const created = await c.env.DB.prepare(
      "SELECT id FROM license_activations WHERE license_id = ? AND installation_hash = ?",
    ).bind(license!.id, installationHash).first<{ id: number }>();
    if (!created) return c.json({ error: "Unable to create activation" }, 500);
    activationId = created.id;
  }

  const refreshToken = randomToken("refresh");
  await c.env.DB.prepare(
    "UPDATE license_activations SET refresh_token_hash = ?, last_seen_at = ?, last_refresh_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).bind(await sha256Hex(refreshToken), now, now, activationId).run();
  return c.json({ ...(await issueAccessToken(c.env, license!, activationId, installationHash)), refreshToken });
});

app.post("/v1/licenses/refresh", async (c) => {
  const body: { refreshToken?: string; installationId?: string; courseraEmail?: string } = await c.req
    .json<{ refreshToken?: string; installationId?: string; courseraEmail?: string }>()
    .catch(() => ({}));
  const courseraEmail = normalizeEmail(body.courseraEmail);
  if (!body.refreshToken || !body.installationId || !isEmail(courseraEmail)) {
    return c.json({ error: "refreshToken, installationId and courseraEmail are required" }, 400);
  }
  const [refreshHash, installationHash] = await Promise.all([
    sha256Hex(body.refreshToken), sha256Hex(body.installationId),
  ]);
  const row = await c.env.DB.prepare(
    `SELECT a.id AS activation_id, a.installation_hash, l.id, l.buyer_email, l.plan, l.status,
            l.expires_at, l.claimed_at
     FROM license_activations a JOIN licenses l ON l.id = a.license_id
     WHERE a.refresh_token_hash = ? AND a.revoked_at IS NULL`,
  ).bind(refreshHash).first<LicenseRow & { activation_id: number; installation_hash: string }>();
  if (!row || !isLicenseActive(row) || row.installation_hash !== installationHash) {
    return c.json({ error: "Invalid refresh token" }, 401);
  }
  if (normalizeEmail(row.buyer_email) !== courseraEmail) {
    return c.json({ error: "Coursera account does not match this license" }, 403);
  }
  const nextRefreshToken = randomToken("refresh");
  const now = new Date().toISOString();
  const rotated = await c.env.DB.prepare(
    `UPDATE license_activations SET refresh_token_hash = ?, last_seen_at = ?, last_refresh_at = ?
     WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`,
  ).bind(await sha256Hex(nextRefreshToken), now, now, row.activation_id, refreshHash).run();
  if ((rotated.meta.changes ?? 0) !== 1) return c.json({ error: "Refresh token replayed" }, 401);
  return c.json({ ...(await issueAccessToken(c.env, row, row.activation_id, installationHash)), refreshToken: nextRefreshToken });
});

app.post("/v1/licenses/recover", async (c) => {
  const body: { courseraEmail?: string; installationId?: string } = await c.req
    .json<{ courseraEmail?: string; installationId?: string }>()
    .catch(() => ({}));
  const courseraEmail = normalizeEmail(body.courseraEmail);
  if (!body.installationId || !isEmail(courseraEmail)) {
    return c.json({ error: "installationId and courseraEmail are required" }, 400);
  }
  const license = await c.env.DB.prepare(
    `SELECT id, buyer_email, plan, status, expires_at, claimed_at FROM licenses
     WHERE buyer_email = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(courseraEmail).first<LicenseRow>();
  if (!isLicenseActive(license)) return c.json({ error: "No active license for this Coursera account" }, 404);

  const installationHash = await sha256Hex(body.installationId);
  const current = await c.env.DB.prepare(
    `SELECT id, installation_hash, last_seen_at FROM license_activations
     WHERE license_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 1`,
  ).bind(license!.id).first<{ id: number; installation_hash: string; last_seen_at: string }>();
  if (
    current && current.installation_hash !== installationHash &&
    Date.parse(current.last_seen_at) > Date.now() - 60_000
  ) return c.json({ error: "Please wait before moving Premium to another device" }, 429);

  const refreshToken = randomToken("refresh");
  const refreshHash = await sha256Hex(refreshToken);
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE license_activations SET revoked_at = ?, refresh_token_hash = NULL WHERE license_id = ? AND revoked_at IS NULL",
    ).bind(now, license!.id),
    c.env.DB.prepare(
      `INSERT INTO license_activations
       (license_id, installation_hash, refresh_token_hash, created_at, last_seen_at, last_refresh_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (license_id, installation_hash) DO UPDATE SET
         refresh_token_hash = excluded.refresh_token_hash, last_seen_at = excluded.last_seen_at,
         last_refresh_at = excluded.last_refresh_at, revoked_at = NULL`,
    ).bind(license!.id, installationHash, refreshHash, now, now, now),
    c.env.DB.prepare("UPDATE licenses SET claimed_at = COALESCE(claimed_at, ?) WHERE id = ?")
      .bind(now, license!.id),
  ]);
  const activation = await c.env.DB.prepare(
    "SELECT id FROM license_activations WHERE license_id = ? AND installation_hash = ? AND revoked_at IS NULL",
  ).bind(license!.id, installationHash).first<{ id: number }>();
  if (!activation) return c.json({ error: "Unable to recover activation" }, 500);
  return c.json({ ...(await issueAccessToken(c.env, license!, activation.id, installationHash)), refreshToken });
});

app.use("/v1/entitlements/*", async (c, next) => {
  const authorization = c.req.header("Authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const payload = await verifyAccessToken<EntitlementToken>(token, c.env.TOKEN_SIGNING_SECRET);
  if (
    !payload ||
    !Number.isInteger(payload.activationId) ||
    !payload.licenseId ||
    !payload.emailHash ||
    !payload.sub
  ) return c.json({ error: "Unauthorized" }, 401);
  c.set("entitlement", payload);
  await next();
});

app.get("/v1/entitlements/me", async (c) => {
  const entitlement = c.get("entitlement");
  const courseraEmail = normalizeEmail(c.req.header("X-Coursera-Email"));
  if (!isEmail(courseraEmail)) return c.json({ error: "Coursera email is required" }, 400);
  const license = await c.env.DB.prepare(
    `SELECT l.status, l.plan, l.expires_at, l.buyer_email, a.installation_hash, a.revoked_at
     FROM licenses l JOIN license_activations a ON a.license_id = l.id
     WHERE l.id = ? AND a.id = ?`,
  ).bind(entitlement.licenseId, entitlement.activationId).first<{
    status: string;
    plan: string;
    expires_at: string | null;
    buyer_email: string;
    installation_hash: string;
    revoked_at: string | null;
  }>();
  const emailHash = license ? await fingerprintEmail(c.env, courseraEmail) : "";
  const active = Boolean(
    license?.status === "ACTIVE" &&
      !license.revoked_at &&
      normalizeEmail(license.buyer_email) === courseraEmail &&
      license.installation_hash === entitlement.sub &&
      emailHash === entitlement.emailHash &&
      (!license.expires_at || Date.parse(license.expires_at) > Date.now()),
  );
  return c.json({
    active,
    plan: license?.plan ?? null,
    features: active ? ["premium"] : [],
    expiresAt: license?.expires_at ?? null,
    emailHash: active ? emailHash : null,
  });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;

