import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { app, BrowserWindow, session } from 'electron';

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

const SENSITIVE_HEADERS = new Set([
  'cookie', 'authorization', 'proxy-authorization', 'x-csrf-token', 'x-xsrf-token',
]);
const MAX_RESPONSE_BODY_SIZE = 1_000_000; // 1 MB
const SKIP_BODY_STATUS_CODES = new Set([204, 304]);

const isTextualContentType = (contentType: string) => {
  const lower = contentType.toLowerCase();
  return lower.startsWith('text/') ||
    lower.includes('json') ||
    lower.includes('xml') ||
    lower.includes('javascript') ||
    lower.includes('yaml') ||
    lower.includes('html');
};

const getResponsesDir = async () => {
  const userDataDir = process.env.INSOMNIA_DATA_PATH || app.getPath('userData');
  const responsesDir = path.join(userDataDir, 'responses');
  await fs.promises.mkdir(responsesDir, { recursive: true });
  return responsesDir;
};

interface InflightEntry {
  method: ProviderCapturedRequest['method'];
  url: string;
  host: string;
  normalizedPath: string;
  key: string;
  queryString: string;
  requestBody: string | null;
  requestContentType: string | null;
  requestHeaders: Array<{ name: string; value: string }>;
  responseStatusCode: number;
  responseStatusMessage: string;
  responseHeaders: Array<{ name: string; value: string }>;
  responseContentType: string;
  responseBodyPath: string | null;
  responseBodySize: number;
}

const createCapturedRequestsCollector = (domainFilters: string[]) => {
  const inflight = new Map<number, InflightEntry>();
  const capturedRequests = new Map<string, ProviderCapturedRequest>();
  const urlToKey = new Map<string, string>();
  const pendingBodyFetches: Promise<void>[] = [];
  let seenRequestCount = 0;
  let filteredRequestCount = 0;

  return {
    onBeforeRequest(details: Electron.OnBeforeRequestListenerDetails) {
      seenRequestCount += 1;
      const method = normalizeCapturedMethod(details.method);
      if (!method) {
        filteredRequestCount += 1;
        return;
      }

      let parsed: URL;
      try {
        parsed = new URL(details.url);
      } catch {
        filteredRequestCount += 1;
        return;
      }

      if (!domainFilters.some(filter => domainMatchesFilter(parsed.hostname, filter))) {
        filteredRequestCount += 1;
        return;
      }

      const resourceType = (details.resourceType || '').toLowerCase();
      const isLikelyApiRequest =
        API_RESOURCE_TYPES.has(resourceType) ||
        parsed.pathname.includes('/api/') ||
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
        !isLikelyStaticAssetPath(parsed.pathname);
      if (!isLikelyApiRequest) {
        filteredRequestCount += 1;
        return;
      }

      // Extract request body from uploadData
      let requestBody: string | null = null;
      if (details.uploadData?.length) {
        const buffers: Buffer[] = [];
        for (const item of details.uploadData) {
          if ('bytes' in item && item.bytes) {
            buffers.push(item.bytes as Buffer);
          }
        }
        if (buffers.length) {
          requestBody = Buffer.concat(buffers).toString('utf-8');
        }
      }

      const normalizedPath = normalizePathToTemplate(parsed.pathname || '/');
      const key = `${method} ${normalizedPath}`;

      urlToKey.set(details.url, key);

      inflight.set(details.id, {
        method,
        url: details.url,
        host: parsed.hostname,
        normalizedPath,
        key,
        queryString: parsed.search || '',
        requestBody,
        requestContentType: null,
        requestHeaders: [],
        responseStatusCode: 0,
        responseStatusMessage: '',
        responseHeaders: [],
        responseContentType: '',
        responseBodyPath: null,
        responseBodySize: 0,
      });
    },

    onBeforeSendHeaders(details: Electron.OnBeforeSendHeadersListenerDetails) {
      const entry = inflight.get(details.id);
      if (!entry) {
        return;
      }

      entry.requestHeaders = Object.entries(details.requestHeaders)
        .filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase()))
        .map(([name, value]) => ({ name, value }));

      const ctEntry = Object.entries(details.requestHeaders)
        .find(([n]) => n.toLowerCase() === 'content-type');
      if (ctEntry) {
        entry.requestContentType = ctEntry[1];
      }
    },

    onHeadersReceived(details: Electron.OnHeadersReceivedListenerDetails) {
      const entry = inflight.get(details.id);
      if (!entry) {
        return;
      }

      entry.responseStatusCode = details.statusCode;
      entry.responseStatusMessage = (details.statusLine || '').replace(/^HTTP\/\S+\s+\d+\s*/, '');

      if (details.responseHeaders) {
        entry.responseHeaders = Object.entries(details.responseHeaders)
          .flatMap(([name, values]) =>
            (Array.isArray(values) ? values : [String(values)]).map(value => ({ name, value })),
          );

        const ct = Object.entries(details.responseHeaders)
          .find(([n]) => n.toLowerCase() === 'content-type');
        if (ct) {
          entry.responseContentType = Array.isArray(ct[1]) ? ct[1][0] : String(ct[1]);
        }
      }
    },

    onCompleted(details: Electron.OnCompletedListenerDetails) {
      const entry = inflight.get(details.id);
      if (!entry) {
        return;
      }

      capturedRequests.set(entry.key, {
        method: entry.method,
        path: entry.normalizedPath,
        host: entry.host,
        url: entry.url,
        requestHeaders: entry.requestHeaders,
        requestBody: entry.requestBody,
        requestContentType: entry.requestContentType,
        queryString: entry.queryString,
        response: entry.responseStatusCode ? {
          statusCode: entry.responseStatusCode,
          statusMessage: entry.responseStatusMessage,
          headers: entry.responseHeaders,
          contentType: entry.responseContentType,
          bodyPath: entry.responseBodyPath,
          bodySize: entry.responseBodySize,
        } : null,
      });

      inflight.delete(details.id);
    },

    setResponseBody(url: string, bodyPath: string, bodySize: number) {
      const key = urlToKey.get(url);
      if (!key) {
        return;
      }

      // Update committed entry if it exists
      const committed = capturedRequests.get(key);
      if (committed?.response) {
        committed.response.bodyPath = bodyPath;
        committed.response.bodySize = bodySize;
      }

      // Also update any matching inflight entries
      for (const entry of inflight.values()) {
        if (entry.url === url) {
          entry.responseBodyPath = bodyPath;
          entry.responseBodySize = bodySize;
        }
      }
    },

    addPendingBodyFetch(promise: Promise<void>) {
      pendingBodyFetches.push(promise);
    },

    async finalize(): Promise<ProviderCapturedRequest[]> {
      if (pendingBodyFetches.length > 0) {
        await Promise.race([
          Promise.allSettled(pendingBodyFetches),
          new Promise(resolve => setTimeout(resolve, 3000)),
        ]);
      }
      return Array.from(capturedRequests.values());
    },

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
    const collector = createCapturedRequestsCollector(options.domainFilters);
    let cdpEnabled = false;

    const complete = async (result: ProviderAuthInWindowResult) => {
      if (resolved) {
        return;
      }
      resolved = true;

      if (cdpEnabled) {
        try {
          child.webContents.debugger.detach();
        } catch { /* already detached */ }
      }

      const capturedRequests = await collector.finalize();
      const stats = collector.getStats();
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

    // --- webRequest hooks ---
    const webRequest = child.webContents.session.webRequest;

    webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      collector.onBeforeRequest(details);
      callback({});
    });

    webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
      collector.onBeforeSendHeaders(details);
      callback({});
    });

    webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
      collector.onHeadersReceived(details);
      callback({});
    });

    webRequest.onCompleted({ urls: ['*://*/*'] }, details => {
      collector.onCompleted(details);
    });

    // --- CDP for response bodies ---
    // Attach synchronously, register listener, then fire-and-forget Network.enable.
    // Network.enable resolves once the page is active, so we don't await it here —
    // the listener will start receiving events once it resolves.
    const cdpRequests = new Map<string, { url: string; status: number; mimeType: string }>();

    try {
      child.webContents.debugger.attach('1.3');
      cdpEnabled = true;

      child.webContents.debugger.on('message', (_event, method, params) => {
        if (resolved) {
          return;
        }

        if (method === 'Network.requestWillBeSent') {
          cdpRequests.set(params.requestId, {
            url: params.request.url,
            status: 0,
            mimeType: '',
          });
        }

        if (method === 'Network.responseReceived') {
          const info = cdpRequests.get(params.requestId);
          if (info) {
            info.status = params.response.status;
            info.mimeType = params.response.mimeType || '';
          }
        }

        if (method === 'Network.loadingFinished') {
          const info = cdpRequests.get(params.requestId);
          if (!info) {
            return;
          }

          if (SKIP_BODY_STATUS_CODES.has(info.status)) {
            return;
          }
          if (!isTextualContentType(info.mimeType)) {
            return;
          }
          if (params.encodedDataLength > MAX_RESPONSE_BODY_SIZE) {
            return;
          }

          const fetchPromise = (async () => {
            try {
              const result = await child.webContents.debugger.sendCommand(
                'Network.getResponseBody',
                { requestId: params.requestId },
              );
              const content = result.base64Encoded
                ? Buffer.from(result.body, 'base64')
                : Buffer.from(result.body, 'utf-8');

              const responsesDir = await getResponsesDir();
              const bodyPath = path.join(responsesDir, `${crypto.randomUUID()}.response`);
              await fs.promises.writeFile(bodyPath, content);

              collector.setResponseBody(info.url, bodyPath, content.length);
            } catch (error) {
              console.warn('[provider-auth] CDP body fetch failed', info.url, error);
            }
          })();

          collector.addPendingBodyFetch(fetchPromise);
        }
      });

      // Fire-and-forget: resolves once webContents is active
      child.webContents.debugger.sendCommand('Network.enable').catch(() => {});
    } catch (error) {
      console.warn('[provider-auth] CDP attach failed, response bodies will not be captured', error);
    }

    const maybeResolveSuccess = async (currentUrl: string, source: string) => {
      if (!matchesSuccessRule(currentUrl, options.successRules)) {
        return;
      }

      try {
        const cookies = await getFilteredCookies(child.webContents.session, options.domainFilters);
        await complete({ status: 'success', cookies });
      } catch (error) {
        await complete({
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
            await complete({ status: 'success', cookies });
            return;
          }
        } catch (error) {
          await complete({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        await complete({ status: 'cancelled' });
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

      await complete({
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

export async function providerAuthInWindowValidateCookies(options: {
  url: string;
  cookies: ProviderCookie[];
}): Promise<{ valid: boolean; statusCode: number }> {
  const cookieHeader = options.cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  try {
    const { net } = require('electron');
    const response = await net.fetch(options.url, {
      method: 'GET',
      headers: { Cookie: cookieHeader },
      redirect: 'manual',
    });
    const valid = response.status >= 200 && response.status < 400;
    return { valid, statusCode: response.status };
  } catch {
    return { valid: false, statusCode: 0 };
  }
}
