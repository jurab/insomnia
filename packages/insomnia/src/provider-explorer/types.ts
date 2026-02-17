export type ProviderId = 'kosik' | 'rohlik' | 'knuspr';

export type ProviderAuthSource = 'popup-login';

export type ProviderAuthStatus = 'success' | 'cancelled' | 'error';

export type UrlMatchRule =
  | {
      type: 'includes';
      value: string;
    }
  | {
      type: 'regex';
      value: string;
      flags?: string;
    };

export interface ProviderCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}

export interface ProviderAuthInWindowStartOptions {
  providerId: ProviderId;
  loginUrl: string;
  successRules: UrlMatchRule[];
  domainFilters: string[];
}

export interface ProviderAuthGetCookiesOptions {
  providerId: ProviderId;
  domainFilters: string[];
}

export interface ProviderAuthInWindowResult {
  status: ProviderAuthStatus;
  cookies?: ProviderCookie[];
  capturedRequests?: ProviderCapturedRequest[];
  error?: string;
}

export interface ProviderCapturedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  host: string;
  url: string;
  requestHeaders: Array<{ name: string; value: string }>;
  requestBody: string | null;
  requestContentType: string | null;
  queryString: string;
  response: {
    statusCode: number;
    statusMessage: string;
    headers: Array<{ name: string; value: string }>;
    contentType: string;
    bodyPath: string | null;
    bodySize: number;
  } | null;
}

export interface ProviderEndpointDefinition {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  name: string;
  headers?: Record<string, string>;
}

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  baseUrl: string;
  auth: {
    loginUrl: string;
    successRules: UrlMatchRule[];
    domainFilters: string[];
  };
  endpoints: ProviderEndpointDefinition[];
}
