export interface Env {
  DB: D1Database;
  PAYOS_CLIENT_ID: string;
  PAYOS_API_KEY: string;
  PAYOS_CHECKSUM_KEY: string;
  TOKEN_SIGNING_SECRET: string;
  EMAIL_PEPPER: string;
  APP_BASE_URL: string;
  RETURN_URL: string;
  CANCEL_URL: string;
  PRODUCT_PRICE_VND: string;
  SUBSCRIPTION_DAYS: string;
  LICENSE_MAX_ACTIVATIONS: string;
}

export interface PayOsWebhookData {
  orderCode: number;
  amount: number;
  description: string;
  accountNumber?: string;
  reference: string;
  transactionDateTime: string;
  currency: string;
  paymentLinkId: string;
  code: string;
  desc: string;
  [key: string]: unknown;
}

export interface PayOsWebhookBody {
  code: string;
  desc: string;
  success: boolean;
  data: PayOsWebhookData;
  signature: string;
}

