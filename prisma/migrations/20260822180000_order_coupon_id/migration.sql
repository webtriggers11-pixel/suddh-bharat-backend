-- Store the coupon id on the order so a consumed coupon use can be RELEASED
-- when the order is cancelled/refunded (couponCode alone was not enough).
ALTER TABLE "Order" ADD COLUMN "couponId" TEXT;
