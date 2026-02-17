import type { ProviderConfig, ProviderId } from './types';

export const providerConfigs: Record<ProviderId, ProviderConfig> = {
  kosik: {
    id: 'kosik',
    label: 'Kosik',
    baseUrl: 'https://www.kosik.cz',
    auth: {
      loginUrl: 'https://www.kosik.cz/',
      successRules: [
        { type: 'includes', value: '/kosik-prihlaseni' },
        { type: 'includes', value: '/api/front/profile' },
      ],
      domainFilters: ['kosik.cz', '.kosik.cz'],
    },
    endpoints: [
      { id: 'direct-profile', method: 'GET', path: '/api/front/profile', name: 'Profile' },
      {
        id: 'direct-web-config',
        method: 'GET',
        path: '/api/front/configuration/web',
        name: 'Web Configuration',
      },
    ],
  },
  rohlik: {
    id: 'rohlik',
    label: 'Rohlik',
    baseUrl: 'https://www.rohlik.cz',
    auth: {
      loginUrl: 'https://www.rohlik.cz/',
      successRules: [{ type: 'includes', value: '/uzivatel/prihlaseni' }],
      domainFilters: ['rohlik.cz', '.rohlik.cz'],
    },
    endpoints: [],
  },
  knuspr: {
    id: 'knuspr',
    label: 'Knuspr',
    baseUrl: 'https://www.knuspr.de',
    auth: {
      loginUrl: 'https://www.knuspr.de/',
      successRules: [{ type: 'includes', value: '/anmelden' }],
      domainFilters: ['knuspr.de', '.knuspr.de'],
    },
    endpoints: [],
  },
};

export const providerConfigList = Object.values(providerConfigs);

export const getProviderConfig = (providerId: ProviderId) => providerConfigs[providerId];
