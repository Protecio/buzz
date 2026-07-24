import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

export type UnsignedNostrEvent = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export type SignedNostrEvent = UnsignedNostrEvent & {
  id: string;
  pubkey: string;
  sig: string;
};

type Nip07Provider = {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent>;
};

declare global {
  interface Window {
    nostr?: Nip07Provider;
  }
}

export class DurableSignerUnavailableError extends Error {
  constructor() {
    super("Secure browser identity storage is unavailable on this device.");
    this.name = "DurableSignerUnavailableError";
  }
}

let ephemeralSecretKey: Uint8Array | null = null;
const browserIdentityDatabase = "buzz-browser-identity-v1";
const browserIdentityStore = "identity";
const wrappingKeyId = "wrapping-key";
const encryptedSecretId = "nostr-secret";

type EncryptedSecret = {
  id: typeof encryptedSecretId;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
};

function getEphemeralSecretKey(): Uint8Array {
  if (!ephemeralSecretKey) {
    ephemeralSecretKey = generateSecretKey();
  }
  return ephemeralSecretKey;
}

export function hasNip07Provider(): boolean {
  return typeof window !== "undefined" && window.nostr != null;
}

export function hasDurableBrowserSigner(): boolean {
  return (
    typeof window !== "undefined" &&
    (hasNip07Provider() ||
      (window.isSecureContext &&
        typeof indexedDB !== "undefined" &&
        crypto?.subtle != null))
  );
}

function openBrowserIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(browserIdentityDatabase, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(browserIdentityStore)) {
        request.result.createObjectStore(browserIdentityStore, {
          keyPath: "id",
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open browser identity."));
  });
}

function readIdentityValue<T>(
  database: IDBDatabase,
  id: string,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(browserIdentityStore, "readonly");
    const request = transaction.objectStore(browserIdentityStore).get(id);
    request.onsuccess = () =>
      resolve(request.result ? (request.result.value as T) : undefined);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not read browser identity."));
  });
}

function writeIdentityValue(
  database: IDBDatabase,
  id: string,
  value: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(browserIdentityStore, "readwrite");
    transaction.objectStore(browserIdentityStore).put({ id, value });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Could not persist browser identity."),
      );
  });
}

async function getDurableBrowserSecretKey(): Promise<Uint8Array> {
  if (!hasDurableBrowserSigner()) {
    throw new DurableSignerUnavailableError();
  }

  const database = await openBrowserIdentityDatabase();
  try {
    let wrappingKey = await readIdentityValue<CryptoKey>(
      database,
      wrappingKeyId,
    );
    if (!wrappingKey) {
      wrappingKey = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      await writeIdentityValue(database, wrappingKeyId, wrappingKey);
    }

    const encrypted = await readIdentityValue<EncryptedSecret>(
      database,
      encryptedSecretId,
    );
    if (encrypted) {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: encrypted.iv.slice().buffer as ArrayBuffer },
        wrappingKey,
        encrypted.ciphertext,
      );
      const secret = new Uint8Array(plaintext);
      if (secret.length !== 32) {
        secret.fill(0);
        throw new Error("The stored browser identity is invalid.");
      }
      return secret;
    }

    const secret = generateSecretKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
      wrappingKey,
      secret.slice().buffer as ArrayBuffer,
    );
    await writeIdentityValue(database, encryptedSecretId, {
      id: encryptedSecretId,
      iv,
      ciphertext,
    } satisfies EncryptedSecret);
    return secret;
  } finally {
    database.close();
  }
}

function sameUnsignedEvent(
  expected: UnsignedNostrEvent,
  actual: SignedNostrEvent,
): boolean {
  return (
    actual.kind === expected.kind &&
    actual.created_at === expected.created_at &&
    actual.content === expected.content &&
    JSON.stringify(actual.tags) === JSON.stringify(expected.tags)
  );
}

/**
 * Sign with NIP-07 when available, otherwise use a local browser identity.
 *
 * The ephemeral fallback preserves anonymous browsing on open relays. Flows
 * that create durable membership must set `requireDurableIdentity` so a reload
 * cannot orphan a relay-membership row.
 */
export async function signNostrEvent(
  template: Omit<UnsignedNostrEvent, "created_at"> & {
    created_at?: number;
  },
  options?: { requireDurableIdentity?: boolean },
): Promise<SignedNostrEvent> {
  const unsigned: UnsignedNostrEvent = {
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  };
  const provider = typeof window === "undefined" ? undefined : window.nostr;

  if (provider) {
    const expectedPubkey = await provider.getPublicKey();
    const signed = await provider.signEvent(unsigned);
    if (
      signed.pubkey !== expectedPubkey ||
      !sameUnsignedEvent(unsigned, signed) ||
      typeof signed.id !== "string" ||
      typeof signed.sig !== "string"
    ) {
      throw new Error("The NIP-07 extension returned an invalid signed event.");
    }
    return signed;
  }

  if (options?.requireDurableIdentity) {
    const secretKey = await getDurableBrowserSecretKey();
    try {
      const signed = finalizeEvent(unsigned, secretKey);
      if (signed.pubkey !== getPublicKey(secretKey)) {
        throw new Error("Failed to use the durable browser identity.");
      }
      return signed;
    } finally {
      secretKey.fill(0);
    }
  }

  const secretKey = getEphemeralSecretKey();
  const signed = finalizeEvent(unsigned, secretKey);
  if (signed.pubkey !== getPublicKey(secretKey)) {
    throw new Error("Failed to create the ephemeral browser identity.");
  }
  return signed;
}
