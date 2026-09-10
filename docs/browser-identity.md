# Browser identity

Protecio Buzz uses one durable Nostr identity per browser profile without
persisting a plaintext secret key.

## Resolution order

1. Use a NIP-07 browser signer when one is installed.
2. Use a discoverable WebAuthn credential with the PRF extension. A
   domain-separated secp256k1 secret is derived only while signing and is then
   zeroed. IndexedDB stores the credential identifier and expected public key,
   never the derived secret.
3. On devices without WebAuthn PRF, create an explicitly device-bound identity.
   Its secret is encrypted with a non-exportable AES-GCM `CryptoKey` stored by
   the browser. This fallback cannot be recovered on another device.

WebAuthn creation and assertion require user verification. Cancelling a passkey
operation never silently creates a lower-assurance device identity.

## Persistence and recovery

- Passkey PRF identities can be restored on another device when the platform
  synchronizes the discoverable credential.
- Device-bound identities persist across reloads in the same browser profile.
  Clearing site data or losing the profile loses that identity.
- Identity replacement is one IndexedDB transaction. Rotation never deletes the
  current identity before a replacement is ready.
- Legacy device-bound records are read and upgraded in place.

Rotating an identity changes the Nostr public key and therefore requires an
explicit acknowledgement that existing memberships may need to be re-linked.

## Device coverage

The browser flow is the common installation-free entry point for current
Chrome, Edge, Safari, Firefox, Android, iOS/iPadOS, and ChromeOS. Passkey PRF
availability depends on the browser and authenticator; the device-bound fallback
keeps the flow usable when it is absent.

Native desktop and mobile clients keep using their platform-specific secure
storage. Browser identity metadata is scoped to the Protecio Buzz origin and is
not shared directly with native applications.

## Verification

The Web smoke suite verifies:

- persistence across reloads;
- passkey recovery after browser storage is removed;
- absence of a persisted Nostr secret in passkey mode;
- cancellation without security downgrade;
- browser-first availability on Safari, mobile, and ChromeOS profiles.
