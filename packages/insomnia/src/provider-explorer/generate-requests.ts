import * as models from '~/models';
import type { Request } from '~/models/request';

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

  let created = 0;
  let updated = 0;
  for (const request of uniqueRequests.values()) {
    const operation = await createOrUpdateRequest({
      parentId: discoveredFolder._id,
      endpoint: {
        id: `${request.method}-${request.path}`,
        method: request.method,
        path: request.path,
        name: `${request.method} ${request.path}`,
      },
      baseUrl: providerConfig.baseUrl,
    });

    if (operation === 'created') {
      created += 1;
    } else {
      updated += 1;
    }
  }

  return {
    folderId: discoveredFolder._id,
    created,
    updated,
    total: uniqueRequests.size,
  };
};
