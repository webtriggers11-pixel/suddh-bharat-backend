import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  assertProviderFree,
  getRowOrThrow,
  normalizeProviderKey,
} from './provider-credentials.util';

describe('provider-credentials.util', () => {
  it('normalizes provider keys to lowercase and trims whitespace', () => {
    expect(normalizeProviderKey('  RazorPay ')).toBe('razorpay');
  });

  it('assertProviderFree rejects when a row already exists', async () => {
    const findByProvider = jest.fn().mockResolvedValue({ id: 'x' });
    await expect(
      assertProviderFree(findByProvider, 'razorpay', 'gateway'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('assertProviderFree resolves when no row exists', async () => {
    const findByProvider = jest.fn().mockResolvedValue(null);
    await expect(
      assertProviderFree(findByProvider, 'razorpay', 'gateway'),
    ).resolves.toBeUndefined();
  });

  it('getRowOrThrow returns the row when found', async () => {
    const findById = jest.fn().mockResolvedValue({ id: 'g1' });
    await expect(
      getRowOrThrow(findById, 'g1', 'Payment gateway'),
    ).resolves.toEqual({ id: 'g1' });
  });

  it('getRowOrThrow throws NotFound when missing', async () => {
    const findById = jest.fn().mockResolvedValue(null);
    await expect(
      getRowOrThrow(findById, 'nope', 'Payment gateway'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
