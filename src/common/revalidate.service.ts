import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Busts the storefront's Next.js Data Cache tags after a write, so cached
 * product/category reads refresh immediately (instead of waiting for their TTL).
 * Fire-and-forget: never blocks or throws into the request path; if the frontend
 * or secret isn't configured it's a silent no-op (the TTL still bounds staleness).
 */
@Injectable()
export class RevalidateService {
  private readonly logger = new Logger(RevalidateService.name);

  constructor(private readonly config: ConfigService) {}

  revalidate(tags: string[]): void {
    const base = this.config.get<string>('FRONTEND_URL')?.replace(/\/+$/, '');
    const secret = this.config.get<string>('REVALIDATE_SECRET');
    if (!base || !secret || tags.length === 0) return;

    void fetch(`${base}/api/revalidate?secret=${encodeURIComponent(secret)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(3000),
    }).catch((e) =>
      this.logger.warn(
        `Cache revalidate failed for [${tags.join(', ')}]: ${String(e)}`,
      ),
    );
  }
}
