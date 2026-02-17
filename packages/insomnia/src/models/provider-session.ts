import { database as db } from '../common/database';
import type { ProviderAuthSource, ProviderCookie, ProviderId } from '../provider-explorer/types';
import type { BaseModel } from './types';

export const name = 'Provider Session';
export const type = 'ProviderSession';
export const prefix = 'psn';
export const canDuplicate = false;
export const canSync = false;

export interface BaseProviderSession {
  providerId: ProviderId;
  cookies: ProviderCookie[];
  capturedAt: number;
  source?: ProviderAuthSource;
}

export type ProviderSession = BaseModel & BaseProviderSession;

export const isProviderSession = (model: Pick<BaseModel, 'type'>): model is ProviderSession => model.type === type;

export function init(): BaseProviderSession {
  return {
    providerId: 'kosik',
    cookies: [],
    capturedAt: 0,
    source: 'popup-login',
  };
}

export function migrate(doc: ProviderSession) {
  return doc;
}

export async function create(patch: Partial<ProviderSession>) {
  if (!patch.parentId) {
    throw new Error(`New ProviderSession missing \`parentId\`: ${JSON.stringify(patch)}`);
  }

  if (!patch.providerId) {
    throw new Error(`New ProviderSession missing \`providerId\`: ${JSON.stringify(patch)}`);
  }

  return db.docCreate<ProviderSession>(type, patch);
}

export async function getByParentIdAndProviderId(parentId: string, providerId: ProviderId) {
  return db.findOne<ProviderSession>(type, { parentId, providerId });
}

export async function update(providerSession: ProviderSession, patch: Partial<ProviderSession>) {
  return db.docUpdate(providerSession, patch);
}

export async function upsertByParentIdAndProviderId(
  parentId: string,
  providerId: ProviderId,
  patch: Pick<ProviderSession, 'cookies' | 'capturedAt'> & Partial<Pick<ProviderSession, 'source'>>,
) {
  const existing = await getByParentIdAndProviderId(parentId, providerId);
  if (existing) {
    return update(existing, patch);
  }

  return create({
    parentId,
    providerId,
    ...patch,
  });
}

