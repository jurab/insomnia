import * as models from '~/models';
import type { Request } from '~/models/request';
import type { ResponseHeader } from '~/models/response';

import { getProviderConfig } from './provider-config';
import type { ProviderCapturedRequest, ProviderEndpointDefinition, ProviderId } from './types';

const PROVIDER_EXPLORER_ROOT_NAME = 'Provider Explorer';
// baseUrl is now resolved per-provider from config
const LEGACY_MODE_FOLDER_NAMES = new Set(['backend', 'direct']);
const DISCOVERED_FOLDER_NAME = 'Discovered';

const buildRequestName = (endpoint: ProviderEndpointDefinition) => `${endpoint.method} ${endpoint.path}`;

const findRequestByEndpoint = (requests: Request[], endpoint: ProviderEndpointDefinition) =>
  requests.find(request => request.name === buildRequestName(endpoint));

const ensureFolder = async (parentId: string, name: string) => {
  const folders = await models.requestGroup.findByParentId(parentId);
  const existing = folders.find(folder => folder.name === name);
  if (existing) {
    return existing;
  }

  return models.requestGroup.create({
    parentId,
    name,
  });
};

const removeFolderRecursively = async (folderId: string): Promise<void> => {
  const requests = await models.request.findByParentId(folderId);
  await Promise.all(requests.map(request => models.request.remove(request)));

  const subfolders = await models.requestGroup.findByParentId(folderId);
  for (const subfolder of subfolders) {
    await removeFolderRecursively(subfolder._id);
  }

  const folder = await models.requestGroup.getById(folderId);
  if (folder) {
    await models.requestGroup.remove(folder);
  }
};

const removeLegacyModeFolders = async (providerFolderId: string): Promise<void> => {
  const folders = await models.requestGroup.findByParentId(providerFolderId);
  for (const folder of folders) {
    if (LEGACY_MODE_FOLDER_NAMES.has(folder.name)) {
      await removeFolderRecursively(folder._id);
    }
  }
};

const createOrUpdateRequest = async ({
  parentId,
  endpoint,
  baseUrl,
}: {
  parentId: string;
  endpoint: ProviderEndpointDefinition;
  baseUrl: string;
}) => {
  const requests = await models.request.findByParentId(parentId);
  const existing = findRequestByEndpoint(requests, endpoint);

  const patch: Partial<Request> = {
    parentId,
    name: buildRequestName(endpoint),
    method: endpoint.method,
    url: `${baseUrl}${endpoint.path}`,
    headers: [
      {
        name: 'Accept',
        value: 'application/json',
      },
      ...Object.entries(endpoint.headers || {}).map(([name, value]) => ({ name, value })),
    ],
  };

  if (existing) {
    await models.request.update(existing, patch);
    return 'updated' as const;
  }

  await models.request.create(patch);
  return 'created' as const;
};

export const generateOrRefreshProviderRequests = async ({
  workspaceId,
  providerId,
}: {
  workspaceId: string;
  providerId: ProviderId;
}) => {
  const providerConfig = getProviderConfig(providerId);

  const rootFolder = await ensureFolder(workspaceId, PROVIDER_EXPLORER_ROOT_NAME);
  const providerFolder = await ensureFolder(rootFolder._id, providerConfig.label);
  await removeLegacyModeFolders(providerFolder._id);

  let created = 0;
  let updated = 0;

  for (const endpoint of providerConfig.endpoints) {
    const operation = await createOrUpdateRequest({
      parentId: providerFolder._id,
      endpoint,
      baseUrl: providerConfig.baseUrl,
    });

    if (operation === 'created') {
      created += 1;
    } else {
      updated += 1;
    }
  }

  return {
    folderId: providerFolder._id,
    created,
    updated,
    total: providerConfig.endpoints.length,
  };
};

export const upsertDiscoveredProviderRequests = async ({
  workspaceId,
  providerId,
  requests,
}: {
  workspaceId: string;
  providerId: ProviderId;
  requests: ProviderCapturedRequest[];
}) => {
  const providerConfig = getProviderConfig(providerId);
  const rootFolder = await ensureFolder(workspaceId, PROVIDER_EXPLORER_ROOT_NAME);
  const providerFolder = await ensureFolder(rootFolder._id, providerConfig.label);
  const discoveredFolder = await ensureFolder(providerFolder._id, DISCOVERED_FOLDER_NAME);

  const uniqueRequests = new Map<string, ProviderCapturedRequest>();
  for (const request of requests) {
    uniqueRequests.set(`${request.method} ${request.path}`, request);
  }

  const existingRequests = await models.request.findByParentId(discoveredFolder._id);

  let created = 0;
  let updated = 0;
  for (const capturedRequest of uniqueRequests.values()) {
    const name = `${capturedRequest.method} ${capturedRequest.path}`;
    const existing = existingRequests.find(r => r.name === name);

    // Use actual captured URL (without query string) so the endpoint is immediately callable
    let requestUrl: string;
    try {
      const parsed = new URL(capturedRequest.url);
      requestUrl = `${parsed.origin}${parsed.pathname}`;
    } catch {
      requestUrl = `${providerConfig.baseUrl}${capturedRequest.path}`;
    }

    // Parse query string into parameters
    const parameters: Array<{ name: string; value: string }> = [];
    if (capturedRequest.queryString) {
      const searchParams = new URLSearchParams(capturedRequest.queryString);
      for (const [paramName, paramValue] of searchParams) {
        parameters.push({ name: paramName, value: paramValue });
      }
    }

    const patch: Partial<Request> = {
      parentId: discoveredFolder._id,
      name,
      method: capturedRequest.method,
      url: requestUrl,
      headers: capturedRequest.requestHeaders.map(h => ({ name: h.name, value: h.value })),
      parameters,
      ...(capturedRequest.requestBody ? {
        body: {
          mimeType: capturedRequest.requestContentType || 'application/json',
          text: capturedRequest.requestBody,
        },
      } : {}),
    };

    let requestId: string;
    if (existing) {
      await models.request.update(existing, patch);
      requestId = existing._id;
      updated += 1;
    } else {
      const createdRequest = await models.request.create(patch);
      requestId = createdRequest._id;
      created += 1;
    }

    // Create a Response record so the response pane shows captured data
    if (capturedRequest.response) {
      const responseHeaders: ResponseHeader[] = capturedRequest.response.headers.map(h => ({
        name: h.name,
        value: h.value,
      }));

      await models.response.create({
        parentId: requestId,
        statusCode: capturedRequest.response.statusCode,
        statusMessage: capturedRequest.response.statusMessage,
        headers: responseHeaders,
        contentType: capturedRequest.response.contentType,
        bodyPath: capturedRequest.response.bodyPath || '',
        bodyCompression: null,
        bytesContent: capturedRequest.response.bodySize,
        bytesRead: capturedRequest.response.bodySize,
        elapsedTime: 0,
        environmentId: null,
        url: requestUrl,
      }, 20); // keep history of captured responses across browse sessions
    }
  }

  return {
    folderId: discoveredFolder._id,
    created,
    updated,
    total: uniqueRequests.size,
  };
};
