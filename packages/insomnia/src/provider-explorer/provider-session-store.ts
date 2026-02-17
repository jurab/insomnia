import * as models from '~/models';

import type { ProviderAuthSource, ProviderCookie, ProviderId } from './types';

export const saveProviderSession = async ({
  organizationId,
  providerId,
  cookies,
  source = 'popup-login',
}: {
  organizationId: string;
  providerId: ProviderId;
  cookies: ProviderCookie[];
  source?: ProviderAuthSource;
}) => {
  return models.providerSession.upsertByParentIdAndProviderId(organizationId, providerId, {
    cookies,
    source,
    capturedAt: Date.now(),
  });
};

export const getProviderSession = async (organizationId: string, providerId: ProviderId) => {
  return models.providerSession.getByParentIdAndProviderId(organizationId, providerId);
};

