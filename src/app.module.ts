import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import { ProductsModule } from './products/products.module';
import { CartModule } from './cart/cart.module';
import { AddressesModule } from './addresses/addresses.module';
import { OrdersModule } from './orders/orders.module';
import { StoreConfigModule } from './store-config/store-config.module';
import { ShippingModule } from './shipping/shipping.module';
import { PaymentModule } from './payment/payment.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WishlistModule } from './wishlist/wishlist.module';
import { CouponsModule } from './coupons/coupons.module';
import { ReviewsModule } from './reviews/reviews.module';
import { RevalidateModule } from './common/revalidate.module';
import { RedisModule } from './common/redis.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { PaymentGatewaysModule } from './payment-gateways/payment-gateways.module';
import { ShippingConfigsModule } from './shipping-configs/shipping-configs.module';
import { StoreSettingsModule } from './store-settings/store-settings.module';
import { BulkUploadModule } from './bulk-upload/bulk-upload.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RevalidateModule,
    RedisModule,
    // Per-IP rate limiting (spec §3). Generous default for storefront browsing;
    // sensitive routes (auth, checkout, payment) tighten it via @Throttle.
    // Uses a SHARED Redis store when REDIS_URL is set so limits hold ACROSS
    // instances (in-memory otherwise — correct only for a single instance).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL');
        return {
          throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
          ...(url ? { storage: new ThrottlerStorageRedisService(url) } : {}),
        };
      },
    }),
    PrismaModule,
    StoreConfigModule,
    UsersModule,
    AuthModule,
    CategoriesModule,
    ProductsModule,
    CartModule,
    AddressesModule,
    OrdersModule,
    ShippingModule,
    PaymentModule,
    WebhooksModule,
    WishlistModule,
    CouponsModule,
    ReviewsModule,
    DashboardModule,
    PaymentGatewaysModule,
    ShippingConfigsModule,
    StoreSettingsModule,
    BulkUploadModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global per-IP throttling. Runs alongside the auth/roles guards.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
