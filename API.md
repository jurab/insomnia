# Insomnia Fork — Provider API Explorer

## What this is

This is a fork of [Insomnia](https://github.com/Kong/insomnia) (the open-source API client) repurposed as a **grocery provider API explorer**. It's part of the Goulash project — a meal planning app that integrates with Czech/German online grocery providers.

The fork adds a Provider Explorer workflow on top of Insomnia's existing request/response infrastructure. Instead of manually crafting API requests, you can browse provider websites in a popup, and the app automatically captures every API call the site makes — complete with headers, request bodies, query params, and response data. This turns Insomnia into a passive API discovery tool.

### Supported providers

| Provider | Domain | Market |
|----------|--------|--------|
| Kosik | kosik.cz | Czech Republic |
| Rohlik | rohlik.cz | Czech Republic |
| Knuspr | knuspr.de | Germany |

### Main features

**Provider auth via popup browser** — Opens the real provider website in an Electron BrowserWindow with a persistent session partition. You log in normally. Cookies are captured from the Electron session and persisted across app restarts.

**Passive API discovery** — While you browse the provider site, the app captures all HTTP traffic using 4 Electron webRequest hooks (`onBeforeRequest`, `onBeforeSendHeaders`, `onHeadersReceived`, `onCompleted`) plus Chrome DevTools Protocol for response bodies. Captured endpoints are deduplicated and normalized (numeric IDs replaced with `:id` templates).

**Automatic request generation** — Discovered endpoints are upserted as standard Insomnia Request models, pre-filled with the actual headers, body, and query params from the capture. Each request also gets a stored Response with the real response data, so you can inspect what the API returned without re-executing.

**Cookie management** — Captured provider cookies are synced into the workspace cookie jar, so generated requests are immediately executable. A health check indicator (green/red/grey) in the top bar shows whether cookies are still valid. Click to clear cookies and re-authenticate.

**Streamlined UI** — The debug view is stripped down to essentials: a provider dropdown + URL bar at top, a collapsible URL-path tree sidebar (instead of flat list), and the request/response panes. Tabs, footer, tutorial panels, and docs tab are removed. A "Raw" tab shows the assembled HTTP request as text.

### Two types of endpoint data

1. **Backend proxy endpoints** (in `Goulash API v2/Provider Kosik/` etc.) — These hit `localhost:8000`, the Goulash FastAPI backend, which proxies requests to providers. Pre-defined, manually curated.

2. **Discovered endpoints** (in `Provider Explorer/Kosik/Discovered/` etc.) — These are captured from real browser traffic when you use the Browse feature. They hit provider domains directly (e.g. `www.kosik.cz`). Auto-generated, include full request/response data.

---

## Database location

```
~/Library/Application Support/Insomnia/
```

Override via `INSOMNIA_DATA_PATH` env var. Each model type has its own file:

| File | Contents |
|------|----------|
| `insomnia.Request.db` | API endpoints (method, URL, headers, body, params) |
| `insomnia.RequestGroup.db` | Folders that organize requests |
| `insomnia.Response.db` | Captured responses (status, headers, body path) |
| `insomnia.Workspace.db` | Workspaces (top-level containers) |
| `insomnia.CookieJar.db` | Cookie jars per workspace |

---

## NeDB file format

**Critical:** These are NOT plain JSON files. They're NeDB append-only logs with specific semantics:

- One JSON object per line (newline-delimited)
- Later lines for the same `_id` **overwrite** earlier ones (in-place updates)
- Lines with `$$deleted: true` **remove** that `_id`
- You MUST deduplicate by `_id`, keeping the last occurrence

### Correct parsing (Python)

```python
import json

DATA_DIR = '~/Library/Application Support/Insomnia'

def load_db(model_type):
    """Load all live documents from a NeDB file."""
    docs = {}
    path = f'{DATA_DIR}/insomnia.{model_type}.db'
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            doc = json.loads(line)
        except json.JSONDecodeError:
            continue
        doc_id = doc.get('_id')
        if not doc_id:
            continue
        if doc.get('$$deleted'):
            docs.pop(doc_id, None)
        else:
            docs[doc_id] = doc
    return list(docs.values())
```

**Wrong:** Reading line-by-line without dedup. You'll get ghost entries from old updates.

---

## Current data layout

The scratchpad workspace (`wrk_scratchpad`) contains the Goulash API collection:

```
wrk_scratchpad                          ← workspace
  ├── Goulash API                       ← legacy flat list
  └── Goulash API v2                    ← organized by domain
        ├── Config/
        ├── User/
        ├── Chef/
        ├── Meal/
        ├── Meal Plans/
        ├── Meal Reviews/
        ├── Cookbook/
        ├── My Menu/
        ├── Groceries/
        ├── Store/
        ├── Provider Common/            ← generic provider endpoints ({{provider}} variable)
        ├── Provider Proxy/             ← proxy endpoints ({{provider}} variable)
        ├── Provider Kosik/             ← 23 Kosik-specific endpoints
        ├── Provider Rohlik/            ← 3 Rohlik-specific endpoints
        ├── Cooking/
        ├── Spin Wheel/
        ├── Upsale/
        └── Vouchers/
```

When the Provider Explorer feature runs (via the UI), it creates a separate tree:

```
wrk_scratchpad
  └── Provider Explorer/                ← created at runtime by generate-requests.ts
        ├── Kosik/
        │     ├── GET /api/front/profile         ← seed endpoint
        │     └── Discovered/                    ← captured from browser
        │           ├── GET /api/front/...
        │           └── POST /api/front/...
        ├── Rohlik/
        └── Knuspr/
```

---

## Querying endpoints

### Load everything

```python
folders = load_db('RequestGroup')
requests = load_db('Request')

# Build lookup indexes
folders_by_id = {f['_id']: f for f in folders}
folders_by_parent = {}
for f in folders:
    folders_by_parent.setdefault(f['parentId'], []).append(f)
requests_by_parent = {}
for r in requests:
    requests_by_parent.setdefault(r['parentId'], []).append(r)
```

### Get all Kosik endpoints (by folder name)

```python
kosik_folder = next((f for f in folders if f['name'] == 'Provider Kosik'), None)
kosik_requests = requests_by_parent.get(kosik_folder['_id'], [])

for r in kosik_requests:
    print(f"{r['method']} {r['url']}")
```

### Get all Kosik endpoints (by URL match)

Simpler, doesn't require folder traversal. Works for both backend-proxy and direct URLs:

```python
kosik_requests = [r for r in requests if 'kosik' in r.get('url', '').lower()]

for r in kosik_requests:
    print(f"{r['method']} {r['url']}")
```

### Walk the folder tree from workspace

```python
workspace_id = 'wrk_scratchpad'

# Find "Goulash API v2" folder
goulash = next(
    (f for f in folders_by_parent.get(workspace_id, [])
     if f['name'] == 'Goulash API v2'),
    None
)

# Find provider subfolder
provider_kosik = next(
    (f for f in folders_by_parent.get(goulash['_id'], [])
     if 'kosik' in f['name'].lower()),
    None
)

# Get requests
reqs = requests_by_parent.get(provider_kosik['_id'], [])
```

### Filter by provider (all three strategies)

```python
PROVIDER_DOMAINS = {
    'kosik':  'kosik',
    'rohlik': 'rohlik',
    'knuspr': 'knuspr',
}

PROVIDER_FOLDER_NAMES = {
    'kosik':  'Provider Kosik',
    'rohlik': 'Provider Rohlik',
    'knuspr': 'Provider Knuspr',   # may not exist yet
}

def get_provider_requests(provider_id, requests, folders):
    """Get all requests for a provider. Tries folder match first, falls back to URL match."""
    # Strategy 1: folder name match (most precise)
    folder = next((f for f in folders if f['name'] == PROVIDER_FOLDER_NAMES.get(provider_id)), None)
    if folder:
        return [r for r in requests if r.get('parentId') == folder['_id']]

    # Strategy 2: URL domain match (catches everything)
    domain = PROVIDER_DOMAINS[provider_id]
    return [r for r in requests if domain in r.get('url', '').lower()]
```

---

## Request document shape

```python
{
    "_id": "req_g2_provider-kosik_get_groceries_providers_kosik_proxy_address",
    "type": "Request",
    "parentId": "fld_goulash_provider_kosik",  # folder ID
    "name": "GET /groceries/providers/kosik/proxy/address",
    "method": "GET",
    "url": "http://localhost:8000/api/v1/groceries/providers/kosik/proxy/address",
    "headers": [
        {"name": "Authorization", "value": "Bearer {{token}}"},
        {"name": "Content-Type", "value": "application/json"}
    ],
    "parameters": [],                    # query string params
    "body": {},                          # or {"mimeType": "application/json", "text": "..."}
    "settingSendCookies": true,
    "settingStoreCookies": true,
    "created": 1770114696452,
    "modified": 1770114696452
}
```

Key fields for API exploration:
- `method` — HTTP method
- `url` — full URL (may contain `{{variables}}` like `{{token}}`, `{{address_id}}`)
- `headers` — request headers array
- `parameters` — query string parameters array
- `body` — request body (empty `{}` for GET, `{mimeType, text}` for POST/PUT/PATCH)
- `name` — human-readable endpoint name

---

## Response document shape

```python
{
    "_id": "res_...",
    "type": "Response",
    "parentId": "req_...",               # request ID this response belongs to
    "statusCode": 200,
    "statusMessage": "OK",
    "headers": [{"name": "content-type", "value": "application/json"}],
    "contentType": "application/json",
    "bodyPath": "/Users/.../responses/uuid.response",  # body stored as file on disk
    "bytesContent": 1234,
    "url": "https://www.kosik.cz/api/front/profile",
    "elapsedTime": 0,                   # 0 for captured (not executed) responses
    "created": 1770114696452
}
```

Response bodies are **files on disk**, not inline. Read `bodyPath` to get the actual response content:

```python
import os

def get_response_body(response):
    body_path = response.get('bodyPath', '')
    if body_path and os.path.exists(body_path):
        with open(body_path, 'rb') as f:
            return f.read()
    return None
```

---

## Folder document shape

```python
{
    "_id": "fld_goulash_provider_kosik",
    "type": "RequestGroup",
    "parentId": "fld_goulash_api_v2",    # parent folder or workspace ID
    "name": "Provider Kosik",
    "created": 1770114696452,
    "modified": 1770114696452
}
```

---

## Workspace IDs (current)

| ID | Name |
|----|------|
| `wrk_scratchpad` | Scratch Pad (main workspace, contains Goulash API) |
| `wrk_goulash_claude` | Goulash (Claude) |
| `wrk_417bc356cf7346b2be88f0ef720079ae` | Studio |
| `wrk_8dfeaaf2843742d7b2e6052e356fd8bf` | Plant Jammer |

---

## Complete working example

```python
#!/usr/bin/env python3
"""Dump all Kosik API endpoints from Insomnia DB."""

import json
import os

DATA_DIR = os.path.expanduser('~/Library/Application Support/Insomnia')

def load_db(model_type):
    docs = {}
    path = os.path.join(DATA_DIR, f'insomnia.{model_type}.db')
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            doc = json.loads(line)
        except json.JSONDecodeError:
            continue
        doc_id = doc.get('_id')
        if not doc_id:
            continue
        if doc.get('$$deleted'):
            docs.pop(doc_id, None)
        else:
            docs[doc_id] = doc
    return list(docs.values())

requests = load_db('Request')
responses = load_db('Response')

# Filter to Kosik
kosik_requests = [r for r in requests if 'kosik' in r.get('url', '').lower()]

# Index responses by parent request ID
responses_by_request = {}
for resp in responses:
    responses_by_request.setdefault(resp['parentId'], []).append(resp)

print(f'Kosik endpoints: {len(kosik_requests)}')
print()

for req in sorted(kosik_requests, key=lambda r: r['url']):
    print(f"{req['method']:6s} {req['url']}")

    # Show headers
    for h in req.get('headers', []):
        print(f"       {h['name']}: {h['value']}")

    # Show body if present
    body = req.get('body', {})
    if body.get('text'):
        print(f"       Body ({body.get('mimeType', '?')}): {body['text'][:100]}")

    # Show latest response if any
    req_responses = responses_by_request.get(req['_id'], [])
    if req_responses:
        latest = max(req_responses, key=lambda r: r.get('created', 0))
        print(f"       Response: {latest.get('statusCode')} {latest.get('contentType', '')}")

    print()
```

---

## From inside the Electron app (TypeScript)

If you're writing code inside Insomnia (renderer or main process), use the model API instead of parsing DB files:

```ts
import * as models from '~/models';

// All requests under a folder
const requests = await models.request.findByParentId(folderId);

// Single request by ID
const request = await models.request.getById(requestId);

// Latest response for a request
const latest = await models.response.getLatestForRequestId(requestId, environmentId);

// All responses for a request
const allResponses = await models.response.findByParentId(requestId);

// Cookie jar for a workspace
const jar = await models.cookieJar.getOrCreateForParentId(workspaceId);
```
