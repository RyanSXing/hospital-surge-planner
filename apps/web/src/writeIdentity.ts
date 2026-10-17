/** Keep an unknown write outcome tied to its original server idempotency record. */
const storageKey = "hospital-surge.unconfirmed-writes.v1";
let pending: Map<string, string> | undefined;

function identities() {
  if (!pending) {
    try {
      pending = new Map(JSON.parse(sessionStorage.getItem(storageKey) || "[]"));
    } catch {
      pending = new Map();
    }
  }
  return pending;
}
function persist() {
  try {
    // Only SHA256 request fingerprints and random command IDs are stored, never inputs or credentials.
    sessionStorage.setItem(storageKey, JSON.stringify([...identities()]));
  } catch {
    // Private browsing/storage limits must not prevent saving; memory still retains the identity.
  }
}
async function sha256(value: string | ArrayBuffer) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
export async function writeIdentity(
  path: string,
  options: RequestInit,
  headers: Headers,
) {
  let body = options.body;
  if (body instanceof FormData) {
    const fields: unknown[] = [];
    for (const [name, value] of body.entries()) {
      fields.push([
        name,
        typeof value === "string"
          ? value
          : {
              name: value.name,
              type: value.type,
              size: value.size,
              sha256: await sha256(await value.arrayBuffer()),
            },
      ]);
    }
    body = JSON.stringify(fields);
  }
  const fingerprint = await sha256(
    JSON.stringify([
      options.method?.toUpperCase(),
      path,
      headers.get("If-Match"),
      body || "",
    ]),
  );
  let key = identities().get(fingerprint);
  if (!key) {
    key = crypto.randomUUID();
    identities().set(fingerprint, key);
    persist();
  }
  return { key, fingerprint };
}
export function confirmWrite(fingerprint: string, key: string) {
  if (identities().get(fingerprint) === key) {
    identities().delete(fingerprint);
    persist();
  }
}
export function clearWriteIdentities() {
  identities().clear();
  persist();
}
