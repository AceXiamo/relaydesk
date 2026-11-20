"use strict";

const wallets = new Map();
const select = document.querySelector("#provider");
const signIn = document.querySelector("#sign-in");
const statusText = document.querySelector("#login-status");
window.addEventListener("eip6963:announceProvider", ({ detail }) => {
  if (!detail?.provider?.request || !detail.info?.uuid || wallets.has(detail.info.uuid)) return;
  wallets.set(detail.info.uuid, detail.provider);
  select.add(new Option(detail.info.name, detail.info.uuid));
  document.querySelector("#provider-field").hidden = wallets.size < 2;
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

async function post(action, body) {
  const response = await fetch("/api/auth/" + action, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "登录失败，请重试。");
  return result;
}

signIn.addEventListener("click", async () => {
  const provider = wallets.get(select.value) || window.ethereum;
  if (!provider?.request) {
    statusText.textContent = "请启用浏览器钱包扩展，或用钱包内置浏览器打开此页。";
    return;
  }
  signIn.disabled = true;
  try {
    statusText.textContent = "请在钱包中选择管理员账户。";
    const [account] = await provider.request({ method: "eth_requestAccounts" });
    const chain = await provider.request({ method: "eth_chainId" });
    const challenge = await post("challenge", { chain_id: Number(chain) });
    if (account?.toLowerCase() !== challenge.address.toLowerCase()) {
      throw Error("请在钱包中切换到管理员地址 " + challenge.address + " 后重试。");
    }
    statusText.textContent = "请在钱包中确认登录签名。";
    const bytes = new TextEncoder().encode(challenge.message);
    const hex = "0x" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const signature = await provider.request({ method: "personal_sign", params: [hex, account] });
    await post("verify", { nonce: challenge.nonce, signature });
    location.replace("/" + location.hash);
  } catch (error) {
    statusText.textContent = error.code === 4001 ? "已取消，可以重新连接。" : error.message || "登录失败，请重试。";
  } finally {
    signIn.disabled = false;
  }
});
