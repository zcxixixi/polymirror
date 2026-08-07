/** Suggest a config leader id from Polymarket username or wallet address. */
export function suggestLeaderId(userName: string | undefined, address: string): string {
  const fromName = (userName ?? "")
    .replace(/^@/, "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 32);
  if (fromName.length >= 2) return fromName;
  const hex = address.trim().replace(/^0x/i, "").toLowerCase();
  if (hex.length >= 8) return `trader_${hex.slice(0, 8)}`;
  return "trader";
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function parseFollowTarget(raw: string):
  | { mode: "address"; address: string }
  | { mode: "username"; username: string }
  | null {
  const value = raw.trim();
  if (!value) return null;
  if (ADDRESS_RE.test(value)) {
    return { mode: "address", address: value };
  }
  // Incomplete or malformed 0x blobs are not usernames.
  if (/^0x/i.test(value)) return null;
  const username = value.replace(/^@/, "").trim();
  if (!username || /\s/.test(username)) return null;
  return { mode: "username", username };
}
