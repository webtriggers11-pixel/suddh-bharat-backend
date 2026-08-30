import { BulkUploadController } from './bulk-upload.controller';
import { BulkUploadService } from './bulk-upload.service';

describe('BulkUploadController', () => {
  let bulk: jest.Mocked<Pick<BulkUploadService, 'run'>>;
  let controller: BulkUploadController;

  beforeEach(() => {
    bulk = { run: jest.fn().mockResolvedValue({}) };
    controller = new BulkUploadController(bulk as unknown as BulkUploadService);
  });

  it('defaults to a dry run when neither the body nor the query param is supplied', () => {
    void controller.run({ content: 'c' }, undefined);
    expect(bulk.run).toHaveBeenCalledWith('c', true);
  });

  it('performs a live import when the query param explicitly opts out', () => {
    void controller.run({ content: 'c' }, 'false');
    expect(bulk.run).toHaveBeenCalledWith('c', false);
  });

  it('performs a live import when the DTO explicitly sets dryRun to false', () => {
    void controller.run({ content: 'c', dryRun: false }, undefined);
    expect(bulk.run).toHaveBeenCalledWith('c', false);
  });

  it('stays a dry run when the query param is "true"', () => {
    void controller.run({ content: 'c' }, 'true');
    expect(bulk.run).toHaveBeenCalledWith('c', true);
  });
});
