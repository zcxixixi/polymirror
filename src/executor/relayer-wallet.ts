import { ensureUndiciGlobalProxy } from "../util/proxy.js";
import { fetchWithTimeout } from "../util/fetch.js";

const RELAYER_BASE = "https://relayer-v2.polymarket.com";

const deployedCache = new Map<string, boolean>();

export async function fetchRelayerWalletDeployed(address: string): Promise<boolean> {
  const key = address.toLowerCase();
  if (deployedCache.has(key)) return deployedCache.get(key)!;

  await ensureUndiciGlobalProxy();
  const url = `${RELAYER_BASE}/deployed?address=${encodeURIComponent(address)}&type=WALLET`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      deployedCache.set(key, false);
      return false;
    }
    const body = (await res.json()) as { deployed?: boolean };
    const deployed = body.deployed === true;
    deployedCache.set(key, deployed);
    return deployed;
  } catch {
    deployedCache.set(key, false);
    return false;
  }
}

export function clearRelayerWalletCache(): void {
  deployedCache.clear();
}
