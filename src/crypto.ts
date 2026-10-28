const encoder = new TextEncoder();

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function base64UrlEncode(value: string): string {
  const bytes = encoder.encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export async function signAccessToken(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacHex(secret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function verifyAccessToken<T>(token: string, secret: string): Promise<T | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  const expected = await hmacHex(secret, payload);
  if (!timingSafeEqualHex(expected, signature)) return null;

  try {
    const decoded = JSON.parse(base64UrlDecode(payload)) as T & { exp?: number };
    if (typeof decoded.exp === "number" && decoded.exp <= Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${value}`;
}

