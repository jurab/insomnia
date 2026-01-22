import type { CaCertificate } from '~/insomnia-data';

export interface CaCertificateService {
  create(caCertificate: Partial<CaCertificate>): Promise<CaCertificate>;
  findById(id: string): Promise<CaCertificate | null>;
  findByParentId(parentId: string): Promise<CaCertificate[]>;
}
