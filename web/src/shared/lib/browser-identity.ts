import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

export type BrowserIdentityMode =
  | "none"
  | "nip07"
  | "passkey-prf"
  | "device-bound";

export type BrowserIdentityStatus = {
  available: boolean;
  mode: BrowserIdentityMode;
  recoverable: boolean;
  userVerified: boolean;
};

type OwnedBytes = Uint8Array<ArrayBuffer>;

type IdentityMetadata = {
  version: 2;
  mode: Exclude<BrowserIdentityMode, "none" | "nip07">;
  publicKey: string;
  credentialId?: OwnedBytes;
  createdAt: string;
};

type EncryptedSecretEnvelope = {
  version: 2;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
};

type LegacyEncryptedSecret = {
  id?: string;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
};

type PrfExtensionResults = {
  prf?: {
    enabled?: boolean;
    results?: {
      first?: ArrayBuffer;
    };
  };
};

type PublicKeyCredentialWithPrf = PublicKeyCredential & {
  getClientExtensionResults(): AuthenticationExtensionsClientOutputs &
    PrfExtensionResults;
};

type PublicKeyCredentialConstructorWithCapabilities =
  typeof PublicKeyCredential & {
    getClientCapabilities?: () => Promise<Record<string, boolean>>;
  };

class PasskeyPrfUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyPrfUnavailableError";
  }
}

const databaseName = "buzz-browser-identity-v1";
const storeName = "identity";
const databaseVersion = 2;
const metadataId = "identity-metadata-v2";
const wrappingKeyId = "wrapping-key";
const encryptedSecretId = "nostr-secret";
const identityLockName = "buzz-browser-identity-v2";
const prfPurpose = new TextEncoder().encode(
  "Protecio Buzz Nostr browser identity PRF v2",
);
const keyDerivationLabel = new TextEncoder().encode(
  "Protecio Buzz secp256k1 identity v2",
);
const envelopeContext = new TextEncoder().encode(
  "Protecio Buzz device-bound identity envelope v2",
);

let operationQueue = Promise.resolve();

function hasSecureBrowserStorage(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof indexedDB !== "undefined" &&
    globalThis.crypto?.subtle != null
  );
}

function hasWebAuthn(): boolean {
  return (
    hasSecureBrowserStorage() &&
    typeof PublicKeyCredential !== "undefined" &&
    navigator.credentials?.create != null &&
    navigator.credentials?.get != null
  );
}

export function hasDurableBrowserSigner(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.nostr != null || hasSecureBrowserStorage())
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open browser identity."));
  });
}

function readValue<T>(
  database: IDBDatabase,
  id: string,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(id);
    request.onsuccess = () =>
      resolve(request.result ? (request.result.value as T) : undefined);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not read browser identity."));
  });
}

function writeValue(
  database: IDBDatabase,
  id: string,
  value: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put({ id, value });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Could not persist browser identity."),
      );
  });
}

function replaceIdentity(
  database: IDBDatabase,
  records: ReadonlyArray<{ id: string; value: unknown }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    store.clear();
    for (const record of records) {
      store.put(record);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Could not replace browser identity."),
      );
  });
}

async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
  let releaseQueue!: () => void;
  const previous = operationQueue;
  operationQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;
  try {
    if (navigator.locks) {
      return await navigator.locks.request(identityLockName, operation);
    }
    return await operation();
  } finally {
    releaseQueue();
  }
}

async function supportsPasskeyPrf(): Promise<boolean> {
  if (!hasWebAuthn()) return false;
  const credentialConstructor =
    PublicKeyCredential as PublicKeyCredentialConstructorWithCapabilities;
  if (!credentialConstructor.getClientCapabilities) return true;
  try {
    const capabilities = await credentialConstructor.getClientCapabilities();
    return capabilities["extension:prf"] ?? capabilities.prf ?? true;
  } catch {
    return true;
  }
}

function prfInput(): AuthenticationExtensionsClientInputs {
  return {
    prf: {
      eval: {
        first: prfPurpose.slice().buffer,
      },
    },
  } as AuthenticationExtensionsClientInputs;
}

function copyBufferSource(value: BufferSource): OwnedBytes {
  const source = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  return new Uint8Array(source);
}

function prfOutput(credential: PublicKeyCredentialWithPrf): OwnedBytes | null {
  const output = credential.getClientExtensionResults().prf?.results?.first;
  return output ? copyBufferSource(output) : null;
}

async function deriveSecretFromPrf(output: Uint8Array): Promise<OwnedBytes> {
  if (output.length !== 32) {
    throw new Error("The passkey returned an invalid PRF result.");
  }
  for (let counter = 0; counter < 256; counter += 1) {
    const material = new Uint8Array(
      keyDerivationLabel.length + output.length + 1,
    );
    material.set(keyDerivationLabel);
    material.set(output, keyDerivationLabel.length);
    material[material.length - 1] = counter;
    const digest = await crypto.subtle.digest("SHA-256", material);
    material.fill(0);
    const secret = new Uint8Array(digest);
    try {
      getPublicKey(secret);
      return secret;
    } catch {
      secret.fill(0);
    }
  }
  throw new Error("Could not derive a valid browser identity.");
}

function randomBytes(length: number): OwnedBytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function requestPasskeyPrf(credentialId?: OwnedBytes): Promise<{
  credentialId: OwnedBytes;
  secret: OwnedBytes;
}> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      userVerification: "required",
      ...(credentialId
        ? {
            allowCredentials: [
              {
                type: "public-key" as const,
                id: credentialId.slice().buffer,
              },
            ],
          }
        : {}),
      extensions: prfInput(),
    },
  })) as PublicKeyCredentialWithPrf | null;
  if (!credential) {
    throw new Error("No passkey was selected.");
  }
  const output = prfOutput(credential);
  if (!output) {
    throw new PasskeyPrfUnavailableError(
      "This passkey does not support protected key derivation.",
    );
  }
  try {
    return {
      credentialId: new Uint8Array(credential.rawId),
      secret: await deriveSecretFromPrf(output),
    };
  } finally {
    output.fill(0);
  }
}

async function createPasskeyPrfIdentity(): Promise<{
  metadata: IdentityMetadata;
  secret: OwnedBytes;
} | null> {
  if (!(await supportsPasskeyPrf())) return null;
  const userHandle = randomBytes(32);
  let credential: PublicKeyCredentialWithPrf | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32),
        rp: { name: "Protecio Buzz" },
        user: {
          id: userHandle,
          name: "Protecio Buzz browser identity",
          displayName: "Protecio Buzz",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        timeout: 120_000,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        extensions: {
          ...prfInput(),
          credProps: true,
        },
      },
    })) as PublicKeyCredentialWithPrf | null;
  } finally {
    userHandle.fill(0);
  }
  if (!credential) {
    throw new Error("No passkey was created.");
  }
  const extensionResults = credential.getClientExtensionResults();
  if (extensionResults.prf?.enabled !== true) {
    throw new PasskeyPrfUnavailableError(
      "This authenticator does not support protected key derivation.",
    );
  }
  const credentialId = new Uint8Array(credential.rawId);
  const registrationOutput = prfOutput(credential);
  const unlocked = registrationOutput
    ? {
        credentialId,
        secret: await deriveSecretFromPrf(registrationOutput),
      }
    : await requestPasskeyPrf(credentialId);
  registrationOutput?.fill(0);
  return {
    metadata: {
      version: 2,
      mode: "passkey-prf",
      publicKey: getPublicKey(unlocked.secret),
      credentialId: unlocked.credentialId,
      createdAt: new Date().toISOString(),
    },
    secret: unlocked.secret,
  };
}

function isValidWrappingKey(value: unknown): value is CryptoKey {
  if (typeof CryptoKey === "undefined" || !(value instanceof CryptoKey)) {
    return false;
  }
  return (
    value.algorithm.name === "AES-GCM" &&
    !value.extractable &&
    value.usages.includes("encrypt") &&
    value.usages.includes("decrypt")
  );
}

async function readDeviceBoundSecret(
  database: IDBDatabase,
): Promise<OwnedBytes | null> {
  const wrappingKey = await readValue<unknown>(database, wrappingKeyId);
  const encrypted = await readValue<
    EncryptedSecretEnvelope | LegacyEncryptedSecret
  >(database, encryptedSecretId);
  if (!wrappingKey || !encrypted) return null;
  if (!isValidWrappingKey(wrappingKey)) {
    throw new Error("The stored device identity key is invalid.");
  }
  const isV2 = "version" in encrypted && encrypted.version === 2;
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: encrypted.iv.slice().buffer,
      ...(isV2
        ? { additionalData: envelopeContext.slice().buffer }
        : undefined),
    },
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

async function createDeviceBoundSecret(
  database: IDBDatabase,
): Promise<OwnedBytes> {
  const wrappingKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const secret = new Uint8Array(generateSecretKey());
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv.slice().buffer,
      additionalData: envelopeContext.slice().buffer,
    },
    wrappingKey,
    secret.slice().buffer,
  );
  const encryptedSecret = {
    version: 2,
    iv,
    ciphertext,
  } satisfies EncryptedSecretEnvelope;
  const metadata = {
    version: 2,
    mode: "device-bound",
    publicKey: getPublicKey(secret),
    createdAt: new Date().toISOString(),
  } satisfies IdentityMetadata;
  await replaceIdentity(database, [
    { id: wrappingKeyId, value: wrappingKey },
    { id: encryptedSecretId, value: encryptedSecret },
    { id: metadataId, value: metadata },
  ]);
  return secret;
}

async function unlockBrowserSecretUnlocked(): Promise<OwnedBytes> {
  if (!hasSecureBrowserStorage()) {
    throw new Error("Secure browser identity storage is unavailable.");
  }
  const database = await openDatabase();
  try {
    const metadata = await readValue<IdentityMetadata>(database, metadataId);
    if (metadata?.mode === "passkey-prf" && metadata.credentialId) {
      const unlocked = await requestPasskeyPrf(metadata.credentialId);
      if (getPublicKey(unlocked.secret) !== metadata.publicKey) {
        unlocked.secret.fill(0);
        throw new Error("The passkey does not match this browser identity.");
      }
      return unlocked.secret;
    }

    const deviceSecret = await readDeviceBoundSecret(database);
    if (deviceSecret) {
      const publicKey = getPublicKey(deviceSecret);
      if (metadata && metadata.publicKey !== publicKey) {
        deviceSecret.fill(0);
        throw new Error("The device identity integrity check failed.");
      }
      if (!metadata) {
        await writeValue(database, metadataId, {
          version: 2,
          mode: "device-bound",
          publicKey,
          createdAt: new Date().toISOString(),
        } satisfies IdentityMetadata);
      }
      return deviceSecret;
    }

    try {
      const passkeyIdentity = await createPasskeyPrfIdentity();
      if (passkeyIdentity) {
        await writeValue(database, metadataId, passkeyIdentity.metadata);
        return passkeyIdentity.secret;
      }
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "AbortError")
      ) {
        throw new Error("Passkey verification was cancelled.");
      }
      if (!(error instanceof PasskeyPrfUnavailableError)) {
        throw error;
      }
    }
    return await createDeviceBoundSecret(database);
  } finally {
    database.close();
  }
}

async function unlockBrowserSecret(): Promise<OwnedBytes> {
  return runExclusive(unlockBrowserSecretUnlocked);
}

export async function getBrowserIdentityStatus(): Promise<BrowserIdentityStatus> {
  if (typeof window !== "undefined" && window.nostr) {
    return {
      available: true,
      mode: "nip07",
      recoverable: true,
      userVerified: true,
    };
  }
  if (!hasSecureBrowserStorage()) {
    return {
      available: false,
      mode: "none",
      recoverable: false,
      userVerified: false,
    };
  }
  const database = await openDatabase();
  try {
    const metadata = await readValue<IdentityMetadata>(database, metadataId);
    if (metadata) {
      return {
        available: true,
        mode: metadata.mode,
        recoverable: metadata.mode === "passkey-prf",
        userVerified: metadata.mode === "passkey-prf",
      };
    }
    const [wrappingKey, encryptedSecret] = await Promise.all([
      readValue<unknown>(database, wrappingKeyId),
      readValue<unknown>(database, encryptedSecretId),
    ]);
    if (wrappingKey && encryptedSecret) {
      return {
        available: true,
        mode: "device-bound",
        recoverable: false,
        userVerified: false,
      };
    }
    return {
      available: true,
      mode: "none",
      recoverable: await supportsPasskeyPrf(),
      userVerified: false,
    };
  } finally {
    database.close();
  }
}

export async function restoreBrowserIdentityWithPasskey(): Promise<string> {
  if (!(await supportsPasskeyPrf())) {
    throw new Error("Passkey recovery is unavailable on this device.");
  }
  return runExclusive(async () => {
    const unlocked = await requestPasskeyPrf();
    const publicKey = getPublicKey(unlocked.secret);
    unlocked.secret.fill(0);
    const database = await openDatabase();
    try {
      await replaceIdentity(database, [
        {
          id: metadataId,
          value: {
            version: 2,
            mode: "passkey-prf",
            publicKey,
            credentialId: unlocked.credentialId,
            createdAt: new Date().toISOString(),
          } satisfies IdentityMetadata,
        },
      ]);
    } finally {
      database.close();
    }
    return publicKey;
  });
}

export async function rotateBrowserIdentity(options: {
  confirmMembershipReset: boolean;
}): Promise<string> {
  if (!options.confirmMembershipReset) {
    throw new Error("Identity rotation requires explicit confirmation.");
  }
  return runExclusive(async () => {
    const passkeyIdentity = await createPasskeyPrfIdentity().catch((error) => {
      if (error instanceof PasskeyPrfUnavailableError) return null;
      if (
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "AbortError")
      ) {
        throw new Error("Passkey verification was cancelled.");
      }
      throw error;
    });
    const database = await openDatabase();
    try {
      if (passkeyIdentity) {
        await replaceIdentity(database, [
          { id: metadataId, value: passkeyIdentity.metadata },
        ]);
        return passkeyIdentity.metadata.publicKey;
      }
      const secret = await createDeviceBoundSecret(database);
      try {
        return getPublicKey(secret);
      } finally {
        secret.fill(0);
      }
    } finally {
      passkeyIdentity?.secret.fill(0);
      database.close();
    }
  });
}

export async function withDurableBrowserSecret<T>(
  operation: (secret: Uint8Array) => T | Promise<T>,
): Promise<T> {
  const secret = await unlockBrowserSecret();
  try {
    return await operation(secret);
  } finally {
    secret.fill(0);
  }
}
