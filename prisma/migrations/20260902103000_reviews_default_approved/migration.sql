-- Reviews are live on submit: there is no moderation queue, so a review held
-- back for approval was never seen by anyone (public reads filter isApproved).
-- Affects NEW rows only — already-pending reviews stay hidden until someone
-- decides to approve them.
ALTER TABLE "Review" ALTER COLUMN "isApproved" SET DEFAULT true;
