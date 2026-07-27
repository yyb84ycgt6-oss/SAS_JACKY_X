/**
 * AES-256-GCM envelope for provider credentials.
 *
 * Keys are encrypted here, in the edge function, before they ever reach the
 * database. The plaintext exists only in function memory for the duration of a
 * single upstream call. Nothing in the client bundle can decrypt these values —
 * AI_VAULT_KEY is a function secret and is never shipped to the browser.
 *
 * Generate the vault key once:
 *   openssl rand -base64 32
 * then set it:
 *   supabase secrets set AI_VAULT_KEY="<output>"
 *
 * Rotating AI_VAULT_KEY invalidates every stored credential — they must be
 * re-entered. There is deliberately no recovery path: a vault key that can be
 * recovered from inside the system is not protecting anything.
 */

const ALGO = "AES-GCM";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard

let cachedKey: CryptoKey | null = null;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getVaultKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  const raw = Deno.env.get("AI_VAULT_KEY");
  if (!raw) {
    throw new Error(
      "AI_VAULT_KEY is not configured. Run: openssl rand -base64 32 " +
        "then: supabase secrets set AI_VAULT_KEY=\"<output>\"",
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = fromBase64(raw);
  } catch {
    throw new Error("AI_VAULT_KEY is not valid base64.");
  }
  if (bytes.length !== 32) {
    throw new Error(`AI_VAULT_KEY must decode to 32 bytes, got ${bytes.length}.`);
  }

  cachedKey = await crypto.subtle.importKey("raw", bytes, ALGO, false, [
    "encrypt",
    "decrypt",
  ]);
  return cachedKey;
}

export async function encryptSecret(
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await getVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}

export async function decryptSecret(
  ciphertext: string,
  iv: string,
): Promise<string> {
  const key = await getVaultKey();
  try {
    const plain = await crypto.subtle.decrypt(
      { name: ALGO, iv: fromBase64(iv) },
      key,
      fromBase64(ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // GCM authentication failure: wrong vault key, or the row was tampered with.
    throw new Error(
      "Credential could not be decrypted. Either AI_VAULT_KEY changed or the " +
        "stored value was modified. Re-enter the affected key.",
    );
  }
}

/** Last 4 characters, for UI disambiguation. Never enough to reconstruct a key. */
export function keyHint(rawKey: string): string {
  return rawKey.length <= 4 ? "****" : rawKey.slice(-4);
}
