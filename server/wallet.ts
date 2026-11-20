import { randomBytes } from "node:crypto";
import { getAddress, isAddress, recoverMessageAddress } from "viem";
import type { Hex } from "viem";

export const WALLET_COOKIE = "__Host-relaydesk";
const CHALLENGE_TTL_MS = 300 * 1000;
const SESSION_TTL_MS = 12 * 3600 * 1000;

export function parseCookieValue(cookieHeader: string | undefined): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === WALLET_COOKIE) {
      return part.slice(idx + 1).trim();
    }
  }
  return "";
}

export function formatSessionCookie(token: string): string {
  const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0;
  return `${WALLET_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

export class WalletAuth {
  readonly address: `0x${string}`;
  readonly origin: string;
  readonly host: string;
  private pending = new Map<string, { expiresAt: number; message: string }>();
  private sessions = new Map<string, number>();

  constructor(address: string, origin: string) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("Set a valid RELAYDESK_ADMIN_WALLET and HTTPS RELAYDESK_ORIGIN");
    }
    if (
      !isAddress(address) ||
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      origin !== `https://${parsed.host}`
    ) {
      throw new Error("Set a valid RELAYDESK_ADMIN_WALLET and HTTPS RELAYDESK_ORIGIN");
    }
    this.address = getAddress(address);
    this.origin = origin;
    this.host = parsed.host;
  }

  challenge(chainId: unknown): { address: string; nonce: string; message: string } {
    if (
      typeof chainId !== "number" ||
      !Number.isInteger(chainId) ||
      chainId <= 0 ||
      chainId >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("Invalid chain ID");
    }
    const nonce = randomBytes(24).toString("hex");
    const now = new Date();
    now.setUTCMilliseconds(0);
    const expires = new Date(now.getTime() + CHALLENGE_TTL_MS);
    const message =
      `${this.host} wants you to sign in with your Ethereum account:\n` +
      `${this.address}\n\n` +
      `Sign in to the Relaydesk admin console.\n\n` +
      `URI: ${this.origin}\n` +
      `Version: 1\n` +
      `Chain ID: ${chainId}\n` +
      `Nonce: ${nonce}\n` +
      `Issued At: ${now.toISOString().replace(".000Z", "+00:00")}\n` +
      `Expiration Time: ${expires.toISOString().replace(".000Z", "+00:00")}`;

    if (this.pending.size >= 1024) {
      const oldest = this.pending.keys().next().value;
      if (oldest) this.pending.delete(oldest);
    }
    this.pending.set(nonce, { expiresAt: Date.now() + CHALLENGE_TTL_MS, message });
    return { address: this.address, nonce, message };
  }

  async verify(nonce: string, signature: string): Promise<string | null> {
    const challenge = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (
      !challenge ||
      challenge.expiresAt <= Date.now() ||
      !/^0x[0-9a-fA-F]{130}$/.test(signature)
    ) {
      return null;
    }
    let signer: `0x${string}`;
    try {
      signer = await recoverMessageAddress({
        message: challenge.message,
        signature: signature as Hex,
      });
    } catch {
      return null;
    }
    if (getAddress(signer) !== this.address) {
      return null;
    }
    const token = randomBytes(32).toString("base64url");
    if (this.sessions.size >= 128) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  authenticated(token: string): boolean {
    if (!token) return false;
    const expiresAt = this.sessions.get(token) ?? 0;
    return expiresAt > Date.now();
  }

  logout(token: string): void {
    if (token) this.sessions.delete(token);
  }
}
