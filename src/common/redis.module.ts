import {
  Global,
  Inject,
  Module,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Injection token for the shared ioredis client. Resolves to `null` when
 * REDIS_URL is unset — every consumer MUST treat Redis as optional and degrade
 * to a local/in-memory path, so a single instance runs with no Redis at all.
 */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * One process-wide Redis connection, shared by any provider that needs
 * cross-instance state (e.g. the Shiprocket bearer-token cache). The throttler
 * keeps its own connection via ThrottlerStorageRedisService; this is for
 * application code. Global so consumers inject the token without importing.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis | null => {
        const url = config.get<string>('REDIS_URL');
        if (!url) return null;
        const client = new Redis(url, {
          maxRetriesPerRequest: 2,
          // Never let a Redis hiccup take down the app — callers catch and
          // fall back. An unhandled 'error' event would crash the process.
          enableOfflineQueue: true,
        });
        client.on('error', () => {
          /* swallowed — consumers log + degrade at call sites */
        });
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly client: Redis | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.client) await this.client.quit().catch(() => undefined);
  }
}
