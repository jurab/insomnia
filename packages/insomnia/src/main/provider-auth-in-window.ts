import { BrowserWindow, session } from 'electron';

import type {
  ProviderAuthGetCookiesOptions,
  ProviderAuthInWindowResult,
  ProviderAuthInWindowStartOptions,
  ProviderCapturedRequest,
  ProviderCookie,
  UrlMatchRule,
} from '~/provider-explorer/types';

import * as models from '../models';
import { ChromiumVerificationResult, URLLoadErrorCodes } from './authorize-user-in-window';

const normalizeHost = (value: string) => value.replace(/^\./, '').toLowerCase();
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch']);
const STATIC_ASSET_EXTENSIONS = new Set([
  'js',
  'css',
  'map',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
  'woff',
  'woff2',
  'ttf',
  'eot',
]);

const domainMatchesFilter = (cookieDomain: string, filter: string) => {
  const domain = normalizeHost(cookieDomain);
  const normalizedFilter = filter.toLowerCase().trim();

  if (normalizedFilter.startsWith('*.')) {
    const suffix = normalizeHost(normalizedFilter.slice(2));
    return domain === suffix || domain.endsWith(`.${suffix}`);
  }

  if (normalizedFilter.startsWith('.')) {
    const suffix = normalizeHost(normalizedFilter);
    return domain === suffix || domain.endsWith(`.${suffix}`);
  }

  const exact = normalizeHost(normalizedFilter);
  return domain === exact || domain.endsWith(`.${exact}`);
};

const matchesSuccessRule = (url: string, rules: UrlMatchRule[]) => {
  return rules.some(rule => {
    if (rule.type === 'includes') {
      return url.includes(rule.value);
    }

    try {
      return new RegExp(rule.value, rule.flags).test(url);
    } catch (error) {
      console.error('[provider-auth] Invalid regex success rule', rule, error);
      return false;
    }
  });
};

const mapProviderCookie = (cookie: Electron.Cookie): ProviderCookie => ({
  name: cookie.name,
  value: cookie.value,
  domain: cookie.domain || '',
  path: cookie.path || '/',
  expires: cookie.session ? undefined : cookie.expirationDate,
  secure: cookie.secure,
  httpOnly: cookie.httpOnly,
  sameSite: cookie.sameSite,
});

const getFilteredCookies = async (session: Electron.Session, domainFilters: string[]) => {
  const allCookies = await session.cookies.get({});

  return allCookies
    .filter(cookie => domainFilters.some(filter => domainMatchesFilter(cookie.domain || '', filter)))
    .map(mapProviderCookie);
};

const normalizeCapturedMethod = (method?: string): ProviderCapturedRequest['method'] | null => {
  const normalized = (method || '').toUpperCase();
  if (normalized === 'GET' || normalized === 'POST' || normalized === 'PUT' || normalized === 'PATCH' || normalized === 'DELETE') {
    return normalized;
  }
  return null;
};

const normalizePathToTemplate = (path: string) => {
  return (
    path
      .split('/')
      .map(segment => {
        if (!segment) {
          return segment;
        }

        // UUID-like segments.
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) {
          return ':id';
        }

        // Numeric IDs.
        if (/^\d+$/.test(segment)) {
          return ':id';
        }

        // Long opaque tokens/hashes.
        if (/^[A-Za-z0-9_-]{16,}$/.test(segment)) {
          return ':id';
        }

        return segment;
      })
      .join('/') || '/'
  );
};

const isLikelyStaticAssetPath = (path: string) => {
  const fileName = path.split('/').pop() || '';
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : '';
  return Boolean(extension && STATIC_ASSET_EXTENSIONS.has(extension));
};

const createCapturedRequestsCollector = (domainFilters: string[]) => {
  const capturedRequests = new Map<string, ProviderCapturedRequest>();
  let seenRequestCount = 0;
  let filteredRequestCount = 0;

  return {
    add: (input: { method?: string; requestUrl: string; resourceType?: string }) => {
      const { method, requestUrl, resourceType } = input;
      seenRequestCount += 1;
      const normalizedMethod = normalizeCapturedMethod(method);
      if (!normalizedMethod) {
        filteredRequestCount += 1;
        return;
      }

      let parsed: URL;
      try {
        parsed = new URL(requestUrl);
      } catch {
        filteredRequestCount += 1;
        return;
      }

      if (!domainFilters.some(filter => domainMatchesFilter(parsed.hostname, filter))) {
        filteredRequestCount += 1;
        return;
      }

      const normalizedResourceType = (resourceType || '').toLowerCase();
      const isLikelyApiRequest =
        API_RESOURCE_TYPES.has(normalizedResourceType) ||
        parsed.pathname.includes('/api/') ||
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod) ||
        !isLikelyStaticAssetPath(parsed.pathname);
      if (!isLikelyApiRequest) {
        filteredRequestCount += 1;
        return;
      }

      const path = normalizePathToTemplate(parsed.pathname || '/');
      const key = `${normalizedMethod} ${path}`;
      capturedRequests.set(key, {
        method: normalizedMethod,
        path,
        host: parsed.hostname,
        url: requestUrl,
      });
    },
    getAll: () => Array.from(capturedRequests.values()),
    getStats: () => ({
      seenRequestCount,
      filteredRequestCount,
      keptRequestCount: capturedRequests.size,
    }),
  };
};

export function providerAuthInWindowStart(
  options: ProviderAuthInWindowStartOptions,
): Promise<ProviderAuthInWindowResult> {
  return new Promise<ProviderAuthInWindowResult>(async resolve => {
    let resolved = false;
    const capturedRequestsCollector = createCapturedRequestsCollector(options.domainFilters);

    const complete = (result: ProviderAuthInWindowResult) => {
      if (resolved) {
        return;
      }
      resolved = true;
      const capturedRequests = capturedRequestsCollector.getAll();
      const stats = capturedRequestsCollector.getStats();
      console.log('[provider-auth] capture stats', {
        providerId: options.providerId,
        ...stats,
        sample: capturedRequests.slice(0, 10).map(request => `${request.method} ${request.path}`),
      });
      resolve({
        ...result,
        capturedRequests,
      });
    };

    const { validateAuthSSL, proxyEnabled, httpProxy, httpsProxy, noProxy } = await models.settings.get();

    const child = new BrowserWindow({
      webPreferences: {
        nodeIntegration: false,
        partition: `persist:provider-auth:${options.providerId}`,
      },
      show: false,
    });

    child.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      capturedRequestsCollector.add({
        method: details.method,
        requestUrl: details.url,
        resourceType: details.resourceType,
      });
      callback({});
    });

    const maybeResolveSuccess = async (currentUrl: string, source: string) => {
      if (!matchesSuccessRule(currentUrl, options.successRules)) {
        return;
      }

      try {
        const cookies = await getFilteredCookies(child.webContents.session, options.domainFilters);
        complete({ status: 'success', cookies });
      } catch (error) {
        complete({
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        child.close();
      }

      console.log(`[provider-auth] ${source}: matched success URL ${currentUrl}`);
    };

    child.webContents.on('did-navigate', () => {
      const currentUrl = child.webContents.getURL();
      void maybeResolveSuccess(currentUrl, 'did-navigate');
    });

    child.webContents.on('will-redirect', (_event, url) => {
      void maybeResolveSuccess(url, 'will-redirect');
    });

    child.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, url) => {
      void maybeResolveSuccess(url, 'did-fail-load');
    });

    child.webContents.session.setCertificateVerifyProc((_request, callback) => {
      if (validateAuthSSL) {
        callback(ChromiumVerificationResult.USE_CHROMIUM_RESULT);
      } else {
        callback(ChromiumVerificationResult.BLIND_TRUST);
      }
    });

    child.on('ready-to-show', child.show.bind(child));

    child.on('close', () => {
      if (resolved) {
        return;
      }

      void (async () => {
        try {
          const cookies = await getFilteredCookies(child.webContents.session, options.domainFilters);
          if (cookies.length > 0) {
            complete({ status: 'success', cookies });
            return;
          }
        } catch (error) {
          complete({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        complete({ status: 'cancelled' });
      })();
    });

    if (proxyEnabled) {
      await child.webContents.session.setProxy({
        proxyRules: (httpProxy ? `http=${httpProxy};` : '') + (httpsProxy ? `https=${httpsProxy}` : ''),
        proxyBypassRules: noProxy,
      });
    }

    try {
      await child.loadURL(options.loginUrl);
    } catch (error) {
      if ((error as { errno?: number }).errno === URLLoadErrorCodes.ERR_ABORTED) {
        return;
      }

      complete({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });

      child.close();
    }
  });
}

export async function providerAuthInWindowGetPersistedCookies(options: ProviderAuthGetCookiesOptions) {
  const partitionSession = session.fromPartition(`persist:provider-auth:${options.providerId}`);
  return getFilteredCookies(partitionSession, options.domainFilters);
}
