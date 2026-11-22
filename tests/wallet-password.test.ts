import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { WalletAuth } from "../server/wallet";

it("issues a revocable session only for the entire configured password", () => {
  const address = "0x0000000000000000000000000000000000000001";
  const origin = "https://example.test";
  const password = randomUUID() + ".";
  const hash = createHash("sha256").update(password).digest("hex");
  const wallet = new WalletAuth(address, origin, hash);
  for (const invalid of [null, password.slice(0, -1), " " + password, password + " ", hash]) {
    expect(wallet.verifyPassword(invalid)).toBeNull();
  }
  const token = wallet.verifyPassword(password)!;
  expect(wallet.authenticated(token)).toBe(true);
  wallet.logout(token);
  expect(wallet.authenticated(token)).toBe(false);
  expect(new WalletAuth(address, origin).verifyPassword(password)).toBeNull();
});
