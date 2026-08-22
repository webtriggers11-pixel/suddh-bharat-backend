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

  it('skips a row missing required fields', async () => {
    const csv = `${HEADER}\n,,MB-2,desc,,,5,,,,,,,,,,No,No,No,No,`;
    const res = await service.run(csv, true);
    expect(res.skipped).toBe(1);
    expect(res.rows[0].error).toMatch(/required/i);
  });
});
