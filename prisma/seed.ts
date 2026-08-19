import { PrismaClient, Category, VerificationStatus } from '@prisma/client';

const prisma = new PrismaClient();

// Minimal, idempotent seed — one verified brand per category. Run: npm run prisma:seed
const brands = [
  { name: 'Honest Pantry', slug: 'honest-pantry', category: Category.FOOD },
  { name: 'Little Sprout', slug: 'little-sprout', category: Category.BABY },
  { name: 'Bare Beauty', slug: 'bare-beauty', category: Category.BEAUTY },
  { name: 'Slow Thread', slug: 'slow-thread', category: Category.CLOTHING },
];

async function main() {
  for (const b of brands) {
    await prisma.brand.upsert({
      where: { slug: b.slug },
      update: {},
      create: { ...b, status: VerificationStatus.VERIFIED },
    });
  }
  const count = await prisma.brand.count();
  console.log(`Seed complete — ${count} brands in the catalogue.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
