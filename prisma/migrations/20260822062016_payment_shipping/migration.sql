-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('NOT_CREATED', 'LABEL_CREATED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED', 'RTO_INITIATED', 'RTO_DELIVERED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "adminNotes" TEXT,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "isFreeShipping" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shippingActualMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shippingCourier" TEXT,
ADD COLUMN     "shippingEtaDays" INTEGER;

-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "gatewayResponse" TEXT,
ADD COLUMN     "gatewaySignature" TEXT;

-- CreateTable
CREATE TABLE "ShipmentDetail" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'shiprocket',
    "shiprocketOrderId" TEXT,
    "shiprocketShipmentId" TEXT,
    "awbNumber" TEXT,
    "courierId" TEXT,
    "courierName" TEXT,
    "trackingUrl" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'NOT_CREATED',
    "shippingCostActualMinor" INTEGER NOT NULL DEFAULT 0,
    "shippingCostChargedMinor" INTEGER NOT NULL DEFAULT 0,
    "packageWeightKg" DOUBLE PRECISION,
    "packageLengthCm" DOUBLE PRECISION,
    "packageBreadthCm" DOUBLE PRECISION,
    "packageHeightCm" DOUBLE PRECISION,
    "labelGeneratedAt" TIMESTAMP(3),
    "pickupScheduledAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "estimatedDelivery" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "isReturn" BOOLEAN NOT NULL DEFAULT false,
    "returnAwb" TEXT,
    "returnReason" TEXT,
    "providerResponse" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipmentDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentTracking" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentTracking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentDetail_orderId_key" ON "ShipmentDetail"("orderId");

-- CreateIndex
CREATE INDEX "ShipmentDetail_awbNumber_idx" ON "ShipmentDetail"("awbNumber");

-- CreateIndex
CREATE INDEX "ShipmentTracking_shipmentId_idx" ON "ShipmentTracking"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentTracking_shipmentId_eventTime_key" ON "ShipmentTracking"("shipmentId", "eventTime");

-- CreateIndex
CREATE INDEX "PaymentTransaction_gatewayOrderId_idx" ON "PaymentTransaction"("gatewayOrderId");

-- AddForeignKey
ALTER TABLE "ShipmentDetail" ADD CONSTRAINT "ShipmentDetail_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentTracking" ADD CONSTRAINT "ShipmentTracking_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "ShipmentDetail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
