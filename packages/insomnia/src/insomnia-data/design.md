# Insomnia Data Architecture

## Directory Structure

```sh
insomnia-data/
├── index.ts                   # Entry 1: export from src/
├── node.ts                    # Entry 2: export from node-src/
│
├── src/                       # Runtime agnostic code
│   ├── index.ts               # Exports
│   ├── config.ts              # configureInsomniaData()
│   │
│   ├── database/              # Database interface
│   │   ├── index.ts
│   │   └── interface.ts       # DatabaseOperations interface
│   │
│   ├── services/              # Service interfaces
│   │   ├── index.ts
│   │   ├── interfaces.ts      # IRequestService, IWorkspaceService, etc.
│   │   └── types.ts           # Service-specific types
│   │
│   └── models/                # Pure data definitions (no dependencies)
│       ├── types.ts           # Shared types
│       ├── index.ts           # Model registry
│       ├── project.ts         # Only: metadata, types, init(), migrate()
│       ├── workspace.ts
│       ├── request.ts
│       ├── request-group.ts
│       ├── response.ts
│       └── ... (all other model files)
│
└── node-src/                   # Node.js implementation
    ├── index                   # Exports
    ├── database                # NeDB implementation
    │
    └── services/               # Node.js service implementations
        ├── index.ts
        ├── base-service.ts
        ├── request-service.ts
        ├── workspace-service.ts
        └── ...
```

## Import Entries

### Entry 1: `~/insomnia-data` (Runtime Agnostic)

**File: `src/index.ts`**

```ts
// Re-export everything from src/
export * from './models';
export * from './database';
export * from './services/interfaces';
export { configureInsomniaData } from './config';
```

### Entry 2: `~/insomnia-data/node` (Node.js Implementation)

**File: `node.ts`**

```ts
// Re-export everything from node-src/
export { createNedbDatabase } from './database';
```

## Dependency Flow

**Key Principles:**

1. **Models = Pure Data**: Only metadata, types, init(), migrate(). Zero dependencies.
1. **Interfaces First**: Database and services have interface definitions
1. **Runtime Injection**: Implementations injected via configureInsomniaData()
1. **Two Entries**: `~/insomnia-data` (agnostic) + `~/insomnia-data/node` (implementation)
1. **Two Folders**: `src/` (agnostic) + `node-src/` (Node.js impl)

## Type Definitions

### models/types.ts

```ts
export type AllTypes = 'Project' | 'Workspace' | 'Request' | ...;

export interface BaseModel {
  _id: string;
  type: AllTypes;
  parentId: string;
  modified: number;
  created: number;
  isPrivate: boolean;
  name: string;
}
```

## Database Interface

### src/database/interface.ts

```ts
import type { BaseModel } from '../models/types';

export interface DatabaseOperations {
  // ...
}
```

## Service Interfaces

### src/services/interfaces.ts

```ts
import type { Request } from '../models/request';
import type { Workspace } from '../models/workspace';
import type { BaseModel } from '../models/types';

// Base service interface
export interface IBaseService<T extends BaseModel> {
  create(patch: Partial<T>): Promise<T>;
  update(doc: T, patch: Partial<T>): Promise<T>;
  remove(doc: T): Promise<void>;
  getById(id: string): Promise<T | undefined>;
  getByParentId(parentId: string): Promise<T[]>;
  all(): Promise<T[]>;
}

// Request service interface
export interface IRequestService extends IBaseService<Request> {
  duplicate(request: Request, patch?: Partial<Request>): Promise<Request>;
  findByMethod(method: string): Promise<Request[]>;
}

// Workspace service interface
export interface IWorkspaceService extends IBaseService<Workspace> {
  createWithDefaults(name: string, projectId: string): Promise<Workspace>;
  getAllRequests(workspaceId: string): Promise<Request[]>;
  duplicate(workspaceId: string, newName: string): Promise<Workspace>;
}

// Services container
export interface Services {
  request: IRequestService;
  workspace: IWorkspaceService;
  // ... other services
}
```

## IoC Configuration

### src/config.ts

```ts
import type { DatabaseOperations } from './database/interface';
import type { Services } from './services/interfaces';

interface InsomniaDataConfig {
  database: IDatabase;
  services: Services;
}

let config: InsomniaDataConfig | null = null;

export function configureInsomniaData(cfg: InsomniaDataConfig): void {
  //
}
```

## Model Structure (Pure Data Only)

### src/models/request.ts

```ts
import type { BaseModel, RequestBody, RequestHeader, RequestParameter, RequestAuthentication } from './types';

// Metadata
export const requestSchema: ModelSchema = {
  name: 'Request',
  type: 'Request',
  prefix: 'req',
  canDuplicate: true,
  canSync: true,
};

// Model-specific interface
export interface BaseRequest {
  url: string;
  method: string;
  body: RequestBody;
  headers: RequestHeader[];
  parameters: RequestParameter[];
  authentication: RequestAuthentication | {};
  metaSortKey: number;
  isPrivate: boolean;
}

// Type composition
export type Request = BaseModel & BaseRequest;

// Type guard
export const isRequest = (model: Pick<BaseModel, 'type'>): model is Request => model.type === type;

// Default values
export function init(): BaseRequest {
  return {
    url: '',
    method: 'GET',
    body: {},
    headers: [],
    parameters: [],
    authentication: {},
    metaSortKey: -1 * Date.now(),
    isPrivate: false,
  };
}

// Migration logic
export function migrate(doc: Request): Request {
  // Handle version migrations
  return doc;
}

// NO database operations here!
```

## Node.js Implementation

### node-src/database

#### node-src/database/database-nedb.ts

### node-src/services/base-service.ts

```ts
import type { DatabaseOperations } from '../../database/interface';
import type { BaseModel } from '../../models/types';
import type { IBaseService } from '../../services/interfaces';

export abstract class BaseService<T extends BaseModel> implements IBaseService<T> {
  constructor(
    protected db: DatabaseOperations,
    protected type: string,
    protected model: { init: () => any; migrate: (doc: T) => T },
  ) {}

  async create(patch: Partial<T> = {}): Promise<T> {
    const defaults = this.model.init();
    return this.db.docCreate<T>(this.type, { ...defaults, ...patch });
  }

  async update(doc: T, patch: Partial<T>): Promise<T> {
    return this.db.docUpdate(doc, patch);
  }

  async remove(doc: T): Promise<void> {
    return this.db.remove(doc);
  }

  async getById(id: string): Promise<T | undefined> {
    return this.db.findOne<T>(this.type, { _id: id });
  }

  async getByParentId(parentId: string): Promise<T[]> {
    return this.db.find<T>(this.type, { parentId });
  }

  async all(): Promise<T[]> {
    return this.db.all<T>(this.type);
  }
}
```

### node-src/services/request-service.ts

```ts
import { BaseService } from './base-service';
import * as requestModel from '../../models/request';
import type { Request } from '../../models/request';
import type { IRequestService } from '../../services/interfaces';
import type { DatabaseOperations } from '../../database/interface';

export class RequestService extends BaseService<Request> implements IRequestService {
  constructor(db: DatabaseOperations) {
    super(db, requestModel.type, requestModel);
  }

  async duplicate(request: Request, patch: Partial<Request> = {}): Promise<Request> {
    const newRequest = { ...request, ...patch };
    delete newRequest._id;
    return this.create(newRequest);
  }

  async findByMethod(method: string): Promise<Request[]> {
    const allRequests = await this.all();
    return allRequests.filter(req => req.method === method);
  }
}
```

### node-src/services/workspace-service.ts

```ts
import { BaseService } from './base-service';
import * as workspaceModel from '../../models/workspace';
import type { Workspace } from '../../models/workspace';
import type { Request } from '../../models/request';
import type { IWorkspaceService } from '../../services/interfaces';
import type { DatabaseOperations } from '../../database/interface';
import type { IRequestService } from '../../services/interfaces';

export class WorkspaceService extends BaseService<Workspace> implements IWorkspaceService {
  constructor(
    db: DatabaseOperations,
    private requestService: IRequestService,
    private environmentService: any, // IEnvironmentService
    private cookieJarService: any, // ICookieJarService
  ) {
    super(db, workspaceModel.type, workspaceModel);
  }

  async createWithDefaults(name: string, projectId: string): Promise<Workspace> {
    const workspace = await this.create({
      name,
      parentId: projectId,
      scope: 'collection',
    });

    await this.environmentService.create({
      parentId: workspace._id,
      name: 'Base Environment',
      data: {},
    });

    await this.cookieJarService.create({
      parentId: workspace._id,
      cookies: [],
    });

    return workspace;
  }

  async getAllRequests(workspaceId: string): Promise<Request[]> {
    return this.requestService.getByParentId(workspaceId);
  }

  async duplicate(workspaceId: string, newName: string): Promise<Workspace> {
    const workspace = await this.getById(workspaceId);
    if (!workspace) throw new Error('Workspace not found');

    const newWorkspace = await this.create({ ...workspace, name: newName });
    delete newWorkspace._id;

    const requests = await this.requestService.getByParentId(workspaceId);
    await Promise.all(requests.map(req => this.requestService.duplicate(req, { parentId: newWorkspace._id })));

    return newWorkspace;
  }
}
```

### node-src/services/index.ts

```ts
import type { DatabaseOperations } from '../../database/interface';
import type { Services } from '../../services/interfaces';
import { RequestService } from './request-service';
import { WorkspaceService } from './workspace-service';
// ... import other services

export function createNodeServices(db: DatabaseOperations): Services {
  const requestService = new RequestService(db);
  const environmentService = new EnvironmentService(db);
  const cookieJarService = new CookieJarService(db);
  const workspaceService = new WorkspaceService(db, requestService, environmentService, cookieJarService);

  return {
    request: requestService,
    workspace: workspaceService,
    // ... other services
  };
}
```

## Usage Examples

### Main Process Setup (Node.js)

```ts
import { configureInsomniaData, getServices } from 'insomnia-data';
import { createNodeDatabase, createNodeServices } from 'insomnia-data/node';

// 3. Configure insomnia-data with both
configureInsomniaData({ database, services });

// 4. Use services for all operations
const { request, workspace } = getServices();

const newRequest = await request.create({
  name: 'My Request',
  url: 'https://api.example.com',
  method: 'GET',
});

const newWorkspace = await workspace.createWithDefaults('My Workspace', projectId);
```

### Renderer Process Setup (Bridge)

```ts
import { configureInsomniaData, getServices } from 'insomnia-data';
import { createBridgeDatabase } from './bridge-database';
import { createBridgeServices } from './bridge-services';

// 1. Create bridge implementations that call main process
const database = createBridgeDatabase();
const services = createBridgeServices();

// 2. Configure with bridge implementations
configureInsomniaData({ database, services });

// 3. Use services - calls will be forwarded to main process
const { request } = getServices();
const newRequest = await request.create({
  name: 'My Request',
  url: 'https://api.example.com',
  method: 'GET',
});
```

### Inso CLI Setup (Node.js)

```ts
import { configureInsomniaData, getServices } from 'insomnia-data';
import { createNodeDatabase, createNodeServices } from 'insomnia-data/node';

// Inso uses same Node.js implementation as main process
const database = createNodeDatabase({ dataPath: '/cli/data' });
const services = createNodeServices(database);

configureInsomniaData({ database, services });

// Use services for CLI operations
const { workspace, request } = getServices();
const workspaces = await workspace.all();
console.log(`Found ${workspaces.length} workspaces`);
```

### Using Models for Validation (No Database/Services Needed)

```ts
import * as requestModel from 'insomnia-data/models/request';
import type { Request } from 'insomnia-data/models/request';

// Models are pure data - use anywhere without database or services
function validateRequest(data: Partial<Request>): Request {
  const defaultRequest = requestModel.init();
  const request = { ...defaultRequest, ...data };

  if (!request.url) {
    throw new Error('URL is required');
  }

  return requestModel.migrate(request as Request);
}

// No database or services needed - just data validation
const validatedRequest = validateRequest({ url: 'https://api.example.com' });
```
