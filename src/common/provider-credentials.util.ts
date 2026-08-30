import { ConflictException, NotFoundException } from '@nestjs/common';

/** Normalize a provider key the same way everywhere (e.g. "RazorPay" → "razorpay"). */
export function normalizeProviderKey(provider: string): string {
  return provider.trim().toLowerCase();
}

/** Shared by PaymentGatewaysService/ShippingConfigsService.create: reject a
 * second row for the same provider key (409). */
export async function assertProviderFree(
  findByProvider: (provider: string) => Promise<unknown>,
  provider: string,
  label: string,
): Promise<void> {
  if (await findByProvider(provider)) {
    throw new ConflictException(
      `A "${provider}" ${label} is already configured`,
    );
  }
}

/** Shared by both services' update/remove/action methods: fetch by id or 404. */
export async function getRowOrThrow<T>(
  findById: (id: string) => Promise<T | null>,
  id: string,
  label: string,
): Promise<T> {
  const row = await findById(id);
  if (!row) throw new NotFoundException(`${label} not found`);
  return row;
}
