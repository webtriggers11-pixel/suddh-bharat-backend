import { BulkUploadService } from './bulk-upload.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseCsv } from './csv.util';

const HEADER =
  'Category Path,Product Name,SKU,Description,Price,MRP,Stock,Collection,Material,Color,Weight (kg),Length (cm),Breadth (cm),Height (cm),HSN Code,Tags,Handmade (Yes/No),Featured (Yes/No),New Arrival (Yes/No),Bestseller (Yes/No),Product URL';

describe('parseCsv', () => {
  it('handles quoted fields with embedded commas and quotes', () => {
    const rows = parseCsv('a,"b,c","d""e"\n1,2,3');
    expect(rows[0]).toEqual(['a', 'b,c', 'd"e']);
    expect(rows[1]).toEqual(['1', '2', '3']);
  });

  it('treats a bare quote mid-field as literal text, not a quote-open', () => {
    const rows = parseCsv(
      'Description,Price\nSterling silver pendant, 18" chain,100',
    );
    expect(rows[1]).toEqual(['Sterling silver pendant', ' 18" chain', '100']);
  });
});

describe('BulkUploadService', () => {
  let prisma: {
    product: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    category: { findFirst: jest.Mock };
  };
  let service: BulkUploadService;

  beforeEach(() => {
    prisma = {
      product: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'p1' }),
        update: jest.fn().mockResolvedValue({ id: 'p1' }),
      },
      category: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    service = new BulkUploadService(prisma as unknown as PrismaService);
  });

  it('dry run validates without persisting', async () => {
    const csv = `${HEADER}\n,Ring,MB-1,desc,100,150,5,,,,,,,,,,Yes,No,No,No,`;
    const res = await service.run(csv, true);
    expect(res.dryRun).toBe(true);
    expect(res.total).toBe(1);
    expect(res.created).toBe(1);
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it('creates a new product on real import and converts rupees to paise', async () => {
    const csv = `${HEADER}\n,Ring,MB-1,desc,100,150,5,,,,,,,,,,Yes,No,No,No,`;
    const res = await service.run(csv, false);
    expect(res.created).toBe(1);
    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priceMinor: 10000, mrpMinor: 15000 }),
      }),
    );
  });

  it('revives a soft-deleted product matched by SKU', async () => {
    prisma.product.findUnique.mockResolvedValue({
      id: 'p9',
      deletedAt: new Date(),
    });
    const csv = `${HEADER}\n,Ring,MB-1,desc,100,150,5,,,,,,,,,,Yes,No,No,No,`;
    const res = await service.run(csv, false);
    expect(res.revived).toBe(1);
    expect(prisma.product.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deletedAt: null, isActive: true }),
      }),
    );
  });

  it('does not reactivate a manually deactivated product on a plain update', async () => {
    prisma.product.findUnique.mockResolvedValue({
      id: 'p9',
      deletedAt: null,
      isActive: false,
    });
    const csv = `${HEADER}\n,Ring,MB-1,desc,100,150,5,,,,,,,,,,Yes,No,No,No,`;
    const res = await service.run(csv, false);
    expect(res.updated).toBe(1);
    const dataArg = prisma.product.update.mock.calls[0][0].data;
    expect(dataArg).not.toHaveProperty('isActive');
    expect(dataArg).not.toHaveProperty('deletedAt');
  });

  it('skips a row missing required fields', async () => {
    const csv = `${HEADER}\n,,MB-2,desc,,,5,,,,,,,,,,No,No,No,No,`;
    const res = await service.run(csv, true);
    expect(res.skipped).toBe(1);
    expect(res.rows[0].error).toMatch(/required/i);
  });

  it('resolves a nested category path by walking the exact parent chain', async () => {
    prisma.category.findFirst.mockImplementation(({ where }) => {
      if (where.name.equals === 'Women' && where.parentId === null) {
        return Promise.resolve({ id: 'women' });
      }
      if (where.name.equals === 'Rings' && where.parentId === 'women') {
        return Promise.resolve({ id: 'women-rings' });
      }
      return Promise.resolve(null);
    });
    const csv = `${HEADER}\n"Women > Rings",Ring,MB-1,desc,100,150,5,,,,,,,,,,Yes,No,No,No,`;
    await service.run(csv, false);
    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ categoryId: 'women-rings' }),
      }),
    );
  });

  it('does not conflate a same-named category under a different parent', async () => {
    // Only "Men > Rings" exists; a "Women > Rings" path must not match it.
    prisma.category.findFirst.mockImplementation(({ where }) => {
      if (where.name.equals === 'Women' && where.parentId === null) {
        return Promise.resolve({ id: 'women' });
      }
      return Promise.resolve(null); // no "Rings" under "women"
    });
    const csv = `${HEADER}\n"Women > Rings",Ring,MB-1,desc,100,150,5,,,,,,,,,,Yes,No,No,No,`;
    const res = await service.run(csv, false);
    expect(res.rows[0].warnings).toEqual([
      'Category "Women > Rings" not found — left uncategorised',
    ]);
    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ categoryId: expect.anything() }),
      }),
    );
  });
});
