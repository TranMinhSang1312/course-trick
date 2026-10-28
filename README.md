# Coursera Tool API

Cloudflare Workers + D1 backend for payOS orders and extension license entitlements.

## Security first

The payOS credentials previously pasted into chat must be rotated. Never commit real credentials. Store production credentials only as Cloudflare encrypted secrets.

## Local setup

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Use test credentials only in `.dev.vars`.

## Create the D1 database

```powershell
npx wrangler login
npx wrangler d1 create coursera-tool-db
```

Copy the returned `database_id` into `wrangler.jsonc`, then run:

```powershell
npm run db:migrate:remote
```

## Configure production secrets

```powershell
npx wrangler secret put PAYOS_CLIENT_ID
npx wrangler secret put PAYOS_API_KEY
npx wrangler secret put PAYOS_CHECKSUM_KEY
npx wrangler secret put TOKEN_SIGNING_SECRET
npx wrangler secret put EMAIL_PEPPER
```

Generate `TOKEN_SIGNING_SECRET` and `EMAIL_PEPPER` independently with a cryptographically secure random generator. Do not reuse a payOS key.

Update the public values in `wrangler.jsonc`:

- `APP_BASE_URL`
- `RETURN_URL`
- `CANCEL_URL`
- `PRODUCT_PRICE_VND`
- `LICENSE_MAX_ACTIVATIONS`

## Verify and deploy

```powershell
npm run typecheck
npm test
npm run deploy
```

After deployment, configure this payOS webhook URL:

```text
https://<worker-name>.<account-subdomain>.workers.dev/v1/webhooks/payos
```

## GitHub deployment

Create an empty GitHub repository, then push this folder:

```powershell
git init
git add .
git commit -m "Initial Cloudflare payOS licensing API"
git branch -M main
git remote add origin https://github.com/<username>/<repository>.git
git push -u origin main
```

In Cloudflare, choose **Workers & Pages → Create → Import a repository**, select the repository, and use:

- Build command: `npm run deploy` only if Cloudflare requests one; otherwise use native Workers Git integration.
- Deploy command: `npx wrangler deploy`.
- Root directory: `/`.

Add encrypted secrets in the Worker dashboard after the first deployment.

## API

- `GET /health`
- `POST /v1/orders`
- `GET /v1/orders/:orderCode`
- `POST /v1/webhooks/payos`
- `POST /v1/licenses/activate`
- `POST /v1/licenses/refresh`
- `POST /v1/licenses/recover`
- `GET /v1/entitlements/me`

The server fixes the product price from its environment. It does not accept an amount supplied by the extension.
The paid email must match the email detected from the active Coursera page. Recovery revokes the former device session, so only one installation can remain active. Access tokens last ten minutes and refresh tokens rotate on every use; a replayed refresh token is rejected. The server fingerprints email addresses with an HMAC secret that never ships in the extension.

Creating another order for an email with an active license is rejected. The extension sends that user to the recovery flow instead, preventing accidental double payment.

The production configuration charges `20,000 VND` and grants 30 days of access. The extension should refresh its short-lived access token on startup; the server remains the authority for `expiresAt`.

