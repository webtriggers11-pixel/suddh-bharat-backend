import { decryptSecret, encryptSecret } from './secret-crypto.util';

describe('secret-crypto.util', () => {
  const originalKey = process.env.CONFIG_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = originalKey;
  });

  it('round-trips a secret', () => {
    process.env.CONFIG_ENCRYPTION_KEY = 'test-key';
    const stored = encryptSecret('rzp_live_secret_123');
    expect(stored).not.toContain('rzp_live_secret_123');
    expect(decryptSecret(stored)).toBe('rzp_live_secret_123');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    process.env.CONFIG_ENCRYPTION_KEY = 'test-key';
    const a = encryptSecret('same-plaintext');
    const b = encryptSecret('same-plaintext');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same-plaintext');
    expect(decryptSecret(b)).toBe('same-plaintext');
  });

  it('throws when CONFIG_ENCRYPTION_KEY is not set', () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    expect(() => encryptSecret('x')).toThrow(/CONFIG_ENCRYPTION_KEY/);
  });

  it('fails to decrypt with the wrong key', () => {
    process.env.CONFIG_ENCRYPTION_KEY = 'key-a';
    const stored = encryptSecret('secret');
    process.env.CONFIG_ENCRYPTION_KEY = 'key-b';
    expect(() => decryptSecret(stored)).toThrow();
  });

  it('rejects a malformed stored value', () => {
    process.env.CONFIG_ENCRYPTION_KEY = 'test-key';
    expect(() => decryptSecret('not-a-valid-value')).toThrow(/Malformed/);
  });
});
