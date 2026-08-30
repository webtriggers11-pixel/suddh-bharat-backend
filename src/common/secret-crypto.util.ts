import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // recommended GCM IV size
const FORMAT_VERSION = 'v1';

/** Any-length passphrase → a fixed 32-byte AES-256 key. */
function deriveKey(): Buffer {
  const raw = process.env.CONFIG_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'CONFIG_ENCRYPTION_KEY is not set — required to store or read encrypted config secrets (payment gateway / shipping provider credentials)',
    );
  }
  return createHash('sha256').update(raw).digest();
}

/**
 * Encrypt a secret (payment gateway key, shipping provider password/webhook
 * secret) for storage at rest. AES-256-GCM, random IV per call. Stored as
 * `v1:<iv>:<authTag>:<ciphertext>`, all base64.
 */
export function encryptSecret(plain: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Decrypt a secret previously stored with `encryptSecret`. */
export function decryptSecret(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(':');
  if (version !== FORMAT_VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted secret');
  }
  const key = deriveKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}
