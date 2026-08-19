import {
  PrismaClient,
  Category,
  VerificationStatus,
  AuthProvider,
  Role,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// Minimal, idempotent seed. Run: npm run prisma:seed
const brands = [
  { name: 'Honest Pantry', slug: 'honest-pantry', category: Category.FOOD },
  { name: 'Little Sprout', slug: 'little-sprout', category: Category.BABY },
  { name: 'Bare Beauty', slug: 'bare-beauty', category: Category.BEAUTY },
  { name: 'Slow Thread', slug: 'slow-thread', category: Category.CLOTHING },
];

// Test accounts — one per role. Same password for convenience (dev only).
const SEED_PASSWORD = 'Password123!';
const users = [
  { email: 'superadmin@shuddha.in', name: 'Super Admin', roles: [Role.SUPERADMIN] },
  { email: 'admin@shuddha.in', name: 'Admin', roles: [Role.ADMIN] },
  { email: 'vendor@shuddha.in', name: 'Vendor', roles: [Role.VENDOR] },
  { email: 'user@shuddha.in', name: 'User', roles: [Role.USER] },
];

async function main() {
  for (const b of brands) {
    await prisma.brand.upsert({
      where: { slug: b.slug },
      update: {},
      create: { ...b, status: VerificationStatus.VERIFIED },
    });
  }

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 12);
  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { roles: u.roles, name: u.name, passwordHash, emailVerified: true },
      create: {
        email: u.email,
        name: u.name,
        roles: u.roles,
        passwordHash,
        emailVerified: true,
        provider: AuthProvider.LOCAL,
      },
    });
  }

  const [brandCount, userCount] = await Promise.all([
    prisma.brand.count(),
    prisma.user.count(),
  ]);
  console.log(`Seed complete — ${brandCount} brands, ${userCount} users.`);
  console.log(`Test accounts (password: ${SEED_PASSWORD}):`);
  for (const u of users) console.log(`  ${u.roles.join('/')}: ${u.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
