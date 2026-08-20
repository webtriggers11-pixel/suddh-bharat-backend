import {
  PrismaClient,
  BrandCategory,
  VerificationStatus,
  AuthProvider,
  Role,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { rupeesToPaise as paise } from '../src/common/money';

const prisma = new PrismaClient();
// Dummy image URLs until S3 is wired (ADR-0010). Deterministic per seed key.
const img = (seed: string): string =>
  `https://picsum.photos/seed/${seed}/800/800`;

// Minimal, idempotent seed. Run: npm run prisma:seed
const brands = [
  { name: 'Honest Pantry', slug: 'honest-pantry', category: BrandCategory.FOOD },
  { name: 'Little Sprout', slug: 'little-sprout', category: BrandCategory.BABY },
  { name: 'Bare Beauty', slug: 'bare-beauty', category: BrandCategory.BEAUTY },
  {
    name: 'Slow Thread',
    slug: 'slow-thread',
    category: BrandCategory.CLOTHING,
  },
];

// Test accounts — one per role. Same password for convenience (dev only).
const SEED_PASSWORD = 'Password123!';
const users = [
  { email: 'superadmin@shuddha.in', name: 'Super Admin', roles: [Role.SUPERADMIN] },
  { email: 'admin@shuddha.in', name: 'Admin', roles: [Role.ADMIN] },
  { email: 'vendor@shuddha.in', name: 'Vendor', roles: [Role.VENDOR] },
  { email: 'user@shuddha.in', name: 'User', roles: [Role.USER] },
];

// Catalog taxonomy: top-level → subcategories.
const catalog: {
  slug: string;
  name: string;
  sortOrder: number;
  children: { slug: string; name: string }[];
}[] = [
  {
    slug: 'food',
    name: 'Food & Pantry',
    sortOrder: 1,
    children: [
      { slug: 'staples', name: 'Staples' },
      { slug: 'snacks', name: 'Snacks' },
    ],
  },
  {
    slug: 'baby',
    name: 'Baby',
    sortOrder: 2,
    children: [
      { slug: 'baby-care', name: 'Baby Care' },
      { slug: 'baby-clothing', name: 'Baby Clothing' },
    ],
  },
  {
    slug: 'beauty',
    name: 'Beauty',
    sortOrder: 3,
    children: [
      { slug: 'skincare', name: 'Skincare' },
      { slug: 'haircare', name: 'Haircare' },
    ],
  },
  {
    slug: 'clothing',
    name: 'Clothing',
    sortOrder: 4,
    children: [
      { slug: 'everyday', name: 'Everyday' },
      { slug: 'ethnic', name: 'Ethnic' },
    ],
  },
];

// Dummy products keyed by subcategory slug.
const products: {
  slug: string;
  name: string;
  categorySlug: string;
  price: number; // rupees
  mrp: number; // rupees
  stock: number;
  tags: string[];
  material?: string;
  color?: string;
  weightKg?: number;
  isFeatured?: boolean;
  isNew?: boolean;
  isBestseller?: boolean;
}[] = [
  { slug: 'stone-ground-atta', name: 'Stone-Ground Whole Wheat Atta (5kg)', categorySlug: 'staples', price: 349, mrp: 420, stock: 40, tags: ['flour', 'wholegrain'], weightKg: 5, isBestseller: true },
  { slug: 'cold-pressed-groundnut-oil', name: 'Cold-Pressed Groundnut Oil (1L)', categorySlug: 'staples', price: 399, mrp: 480, stock: 30, tags: ['oil', 'cold-pressed'], weightKg: 1, isFeatured: true },
  { slug: 'millet-mix-crackers', name: 'Millet Mix Crackers', categorySlug: 'snacks', price: 149, mrp: 180, stock: 60, tags: ['snack', 'millet'], weightKg: 0.2, isNew: true },
  { slug: 'roasted-makhana', name: 'Roasted Makhana — Himalayan Salt', categorySlug: 'snacks', price: 199, mrp: 240, stock: 55, tags: ['snack', 'makhana'], weightKg: 0.1, isBestseller: true },
  { slug: 'gentle-baby-wash', name: 'Gentle Baby Wash — Tear-Free', categorySlug: 'baby-care', price: 279, mrp: 320, stock: 45, tags: ['baby', 'wash'], weightKg: 0.3, isFeatured: true },
  { slug: 'organic-cotton-nappies', name: 'Organic Cotton Nappies (Pack of 6)', categorySlug: 'baby-care', price: 499, mrp: 620, stock: 25, tags: ['baby', 'cotton'], material: 'Organic cotton', weightKg: 0.4 },
  { slug: 'muslin-baby-romper', name: 'Muslin Baby Romper', categorySlug: 'baby-clothing', price: 599, mrp: 750, stock: 20, tags: ['baby', 'romper'], material: 'Muslin cotton', color: 'Sage', isNew: true },
  { slug: 'aloe-vera-gel', name: 'Pure Aloe Vera Gel', categorySlug: 'skincare', price: 249, mrp: 300, stock: 70, tags: ['skincare', 'aloe'], weightKg: 0.2, isBestseller: true },
  { slug: 'kumkumadi-face-oil', name: 'Kumkumadi Radiance Face Oil', categorySlug: 'skincare', price: 899, mrp: 1100, stock: 18, tags: ['skincare', 'ayurveda'], weightKg: 0.05, isFeatured: true },
  { slug: 'bhringraj-hair-oil', name: 'Bhringraj Hair Oil', categorySlug: 'haircare', price: 349, mrp: 420, stock: 35, tags: ['haircare', 'ayurveda'], weightKg: 0.2 },
  { slug: 'handloom-cotton-kurta', name: 'Handloom Cotton Kurta', categorySlug: 'everyday', price: 1299, mrp: 1600, stock: 22, tags: ['clothing', 'handloom'], material: 'Handloom cotton', color: 'Ivory', isFeatured: true },
  { slug: 'block-print-dupatta', name: 'Block-Print Cotton Dupatta', categorySlug: 'ethnic', price: 799, mrp: 999, stock: 28, tags: ['clothing', 'block-print'], material: 'Cotton', color: 'Indigo', isNew: true },
];

async function upsertCategory(data: {
  slug: string;
  name: string;
  sortOrder: number;
  parentId: string | null;
}) {
  const existing = await prisma.category.findFirst({
    where: { slug: data.slug, parentId: data.parentId },
  });
  if (existing) {
    return prisma.category.update({
      where: { id: existing.id },
      data: { name: data.name, sortOrder: data.sortOrder, isActive: true },
    });
  }
  return prisma.category.create({
    data: {
      slug: data.slug,
      name: data.name,
      sortOrder: data.sortOrder,
      parentId: data.parentId,
      image: img(`cat-${data.slug}`),
    },
  });
}

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

  // Categories (top-level then children), remembering ids by slug.
  const categoryIdBySlug = new Map<string, string>();
  for (const top of catalog) {
    const parent = await upsertCategory({
      slug: top.slug,
      name: top.name,
      sortOrder: top.sortOrder,
      parentId: null,
    });
    categoryIdBySlug.set(top.slug, parent.id);
    let order = 1;
    for (const child of top.children) {
      const sub = await upsertCategory({
        slug: child.slug,
        name: child.name,
        sortOrder: order++,
        parentId: parent.id,
      });
      categoryIdBySlug.set(child.slug, sub.id);
    }
  }

  // Products (idempotent by unique slug).
  for (const p of products) {
    const categoryId = categoryIdBySlug.get(p.categorySlug) ?? null;
    const data = {
      name: p.name,
      priceMinor: paise(p.price),
      mrpMinor: paise(p.mrp),
      stock: p.stock,
      images: [img(`${p.slug}-1`), img(`${p.slug}-2`)],
      categoryId,
      tags: p.tags,
      material: p.material,
      color: p.color,
      weightKg: p.weightKg,
      isFeatured: p.isFeatured ?? false,
      isNew: p.isNew ?? false,
      isBestseller: p.isBestseller ?? false,
    };
    await prisma.product.upsert({
      where: { slug: p.slug },
      update: data,
      create: { slug: p.slug, ...data },
    });
  }

  const [brandCount, userCount, categoryCount, productCount] =
    await Promise.all([
      prisma.brand.count(),
      prisma.user.count(),
      prisma.category.count(),
      prisma.product.count(),
    ]);
  console.log(
    `Seed complete — ${brandCount} brands, ${userCount} users, ${categoryCount} categories, ${productCount} products.`,
  );
  console.log(`Test accounts (password: ${SEED_PASSWORD}):`);
  for (const u of users) console.log(`  ${u.roles.join('/')}: ${u.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
