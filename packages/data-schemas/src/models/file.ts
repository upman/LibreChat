import type { IMongoFile } from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { applyEncryption } from '~/encryption/plugin';
import fileSchema from '~/schema/file';

export function createFileModel(mongoose: typeof import('mongoose')) {
  applyTenantIsolation(fileSchema);
  applyEncryption(fileSchema, 'File');
  return mongoose.models.File || mongoose.model<IMongoFile>('File', fileSchema);
}
