-- User activation flag (admin activate/deactivate)
ALTER TABLE "User" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- Admin-managed store settings (singleton)
CREATE TABLE "StoreSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "codEnabled" BOOLEAN NOT NULL DEFAULT true,
    "codChargeMinor" INTEGER NOT NULL DEFAULT 0,
    "freeShippingThresholdMinor" INTEGER,
    "minOrderMinor" INTEGER NOT NULL DEFAULT 0,
    "shiprocketPickupLocation" TEXT,
    "pickupName" TEXT,
    "pickupPhone" TEXT,
    "pickupAddress" TEXT,
    "pickupCity" TEXT,
    "pickupState" TEXT,
    "pickupPincode" TEXT,
    "pickupCountry" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreSettings_pkey" PRIMARY KEY ("id")
);

-- Payment gateways (Razorpay etc.)
CREATE TABLE "PaymentGateway" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "keySecret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isTestMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentGateway_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PaymentGateway_provider_key" ON "PaymentGateway"("provider");

-- Shipping providers (Shiprocket etc.)
CREATE TABLE "ShippingConfig" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "apiEmail" TEXT NOT NULL,
    "apiPassword" TEXT NOT NULL,
    "token" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "webhookSecret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isTestMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShippingConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ShippingConfig_provider_key" ON "ShippingConfig"("provider");
