import { v4 as uuidv4 } from 'uuid';

import * as models from '~/models';
import type { Cookie } from '~/models/cookie-jar';

import type { ProviderCookie } from './types';

type SyncCookieInput = Pick<ProviderCookie, 'name' | 'value' | 'domain' | 'path' | 'expires' | 'secure' | 'httpOnly'>;

const cookieIdentity = (cookie: Pick<SyncCookieInput, 'name' | 'domain' | 'path'>) =>
  `${cookie.domain.toLowerCase()}::${cookie.path || '/'}::${cookie.name}`;

const toCookieJarCookie = (cookie: SyncCookieInput, id?: string): Cookie => ({
  id: id || uuidv4(),
  key: cookie.name,
  value: cookie.value,
  expires: cookie.expires ? new Date(cookie.expires * 1000) : null,
  domain: cookie.domain,
  path: cookie.path || '/',
  secure: Boolean(cookie.secure),
  httpOnly: Boolean(cookie.httpOnly),
});

export const syncProviderCookiesToWorkspace = async ({
  workspaceId,
  cookies,
}: {
  workspaceId: string;
  cookies: ProviderCookie[];
}) => {
  const cookieJar = await models.cookieJar.getOrCreateForParentId(workspaceId);
  const mergedCookies = new Map<string, Cookie>();

  cookieJar.cookies.forEach(existingCookie => {
    mergedCookies.set(
      cookieIdentity({
        name: existingCookie.key,
        domain: existingCookie.domain,
        path: existingCookie.path,
      }),
      existingCookie,
    );
  });

  cookies.forEach(cookie => {
    const identity = cookieIdentity(cookie);
    const existing = mergedCookies.get(identity);
    mergedCookies.set(identity, toCookieJarCookie(cookie, existing?.id));
  });

  const updatedCookieJar = await models.cookieJar.update(cookieJar, {
    cookies: Array.from(mergedCookies.values()),
  });

  return {
    cookieJar: updatedCookieJar,
    importedCookieCount: cookies.length,
    totalCookieCount: updatedCookieJar.cookies.length,
  };
};

