# Provider API Explorer Plan (Insomnia)

## Objective
Build an in-app provider exploration workflow in Insomnia that can:
1. Open provider login in a popup with the real provider page.
2. Capture and persist provider cookie material.
3. Create/refresh query sets for known provider/backend endpoints.

Also remove legacy auth-bypass behavior currently present in local Insomnia modifications.

---

## Non-Goals (for first delivery)
- Rebuilding Insomnia auth architecture.
- Deep schema inference/validation for provider payloads.
- Automatic endpoint discovery from captured traffic.

---

## Current State (confirmed)
- Popup auth primitive exists: `packages/insomnia/src/main/authorize-user-in-window.ts`.
- IPC bridge exists for popup auth: `packages/insomnia/src/main/ipc/main.ts`, `packages/insomnia/src/entry.preload.ts`.
- Cookie persistence model exists: `packages/insomnia/src/models/cookie-jar.ts`.
- Cookie update route exists: `packages/insomnia/src/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.update-cookie-jar.tsx`.
- Debug sidebar already has cookie UI anchor: `packages/insomnia/src/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.tsx`.

Local customizations likely tied to bypass/testing shortcuts:
- `packages/insomnia/src/entry.client.tsx`
- `packages/insomnia/src/utils/router.ts`
- `packages/insomnia/src/routes/organization.tsx`
- `packages/insomnia/src/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.tsx` (upsell removal only; unrelated to provider work)

---

## Architecture Decisions

### 1) Login Surface
Use Electron `BrowserWindow` popup (same mechanism as OAuth flow) rather than embedding a new in-app `<webview>` component.

Why:
- Reuses existing secure/electron-integrated flow.
- Faster path to shipping.
- Easier cookie extraction via Electron session APIs.

### 2) Cookie Storage
Store provider login state in two layers:
- **Provider session model (new):** provider identity + captured cookies + metadata.
- **Workspace cookie jar (existing):** request execution source. On successful provider login, sync provider cookies into active workspace cookie jar.

Why:
- Cookie jar remains Insomnia-native execution source.
- Provider cookies become reusable across workspaces and refreshable.

### 3) Endpoint Catalog Source of Truth
Use static manifest + generator for initial implementation:
- `backend` mode endpoints (your FastAPI proxy routes).
- `direct` mode endpoints (provider domains like `https://www.kosik.cz/api/front/...`).

Later improvement:
- Generate backend list from OpenAPI at runtime or build step.

---

## Implementation Phases

## Phase 0: Cleanup legacy bypass drift
Goal: remove local behavior that hardcodes startup/auth path assumptions.

Tasks:
- Revert forced onboarding/session flags in `packages/insomnia/src/entry.client.tsx`.
- Revert forced scratchpad initial entry in `packages/insomnia/src/utils/router.ts`.
- Revert auth/header suppression in `packages/insomnia/src/routes/organization.tsx`.
- Keep unrelated UI/theme changes out of this feature branch.

Acceptance:
- Startup/auth flow matches upstream Insomnia logic.
- No special bypass path required for normal operation.

---

## Phase 1: Provider domain model + config registry
Goal: define providers once and consume everywhere.

New files:
- `packages/insomnia/src/provider-explorer/types.ts`
- `packages/insomnia/src/provider-explorer/provider-config.ts`

Content:
- `ProviderId = 'kosik' | 'rohlik' | 'knuspr'`
- Login URL per provider.
- Cookie domain filters per provider.
- Success URL match rules per provider.
- Endpoint catalog definitions (direct + backend proxy).

Acceptance:
- Single import gives all provider metadata.

---

## Phase 2: Main-process provider auth + cookie capture
Goal: launch provider popup and return captured cookies.

Files to add/update:
- Add `packages/insomnia/src/main/provider-auth-in-window.ts`
- Update `packages/insomnia/src/main/ipc/main.ts`
- Update `packages/insomnia/src/main/ipc/electron.ts` (IPC typing)
- Update `packages/insomnia/src/entry.preload.ts`

Behavior:
- Open `BrowserWindow` using isolated session partition (e.g. `persist:provider-auth:<provider>`).
- Wait for provider success URL rule hit.
- Extract cookies from popup session for provider domains.
- Return normalized cookie payload to renderer.

Acceptance:
- From renderer, one call returns cookie list for a successful login.
- Close/cancel/failure states are explicit.

---

## Phase 3: Provider session persistence model
Goal: persist provider-level cookie material and metadata.

New model:
- `packages/insomnia/src/models/provider-session.ts`

Schema (initial):
- `_id`, `type`, `parentId` (organization-level parent),
- `providerId`,
- `cookies[]` (normalized values),
- `capturedAt`,
- optional `source` (`popup-login`).

Update exports/index if required by model registration pattern.

Acceptance:
- Can create/update/get provider session by provider.
- Cookies survive app restart.

---

## Phase 4: Sync provider cookies to workspace cookie jar
Goal: make captured cookies immediately usable in request execution.

Files:
- New helper: `packages/insomnia/src/provider-explorer/cookie-sync.ts`
- Use existing update action or direct model update pattern.

Behavior:
- Merge provider cookies into active workspace cookie jar.
- Deduplicate by (`domain`, `path`, `key`).
- Prefer newer cookie values.

Acceptance:
- After login flow, “Manage Cookies” count increases and requests send cookies automatically.

---

## Phase 5: UI integration in debug sidebar
Goal: expose provider explorer controls where users already work.

Primary file:
- `packages/insomnia/src/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.tsx`

New UI component(s):
- `packages/insomnia/src/ui/components/provider-explorer/provider-explorer-modal.tsx`
- optional smaller controls component in same folder.

UI flow:
- Button: “Provider Explorer”.
- Select provider.
- Action: “Login via popup”.
- Show status, cookie count, last captured time.
- Action: “Sync cookies to this workspace”.
- Action: “Generate/Refresh endpoint queries”.

Acceptance:
- User can complete login->capture->sync from one modal.

---

## Phase 6: Generate known endpoint queries
Goal: one-click generation of request collections for provider exploration.

New helper(s):
- `packages/insomnia/src/provider-explorer/generate-requests.ts`

Behavior:
- For selected provider and mode (`backend`/`direct`), create or refresh a folder tree:
  - `Provider Explorer/{provider}/{mode}`
- Upsert requests by stable key (`method + path + mode`).
- Set URL, method, default headers.
- For backend mode, point to configured backend base URL variable.
- For direct mode, point to provider host.

Initial known endpoints (Kosik seed):
- `/api/front/profile`
- `/api/front/configuration/web`
- plus backend proxy routes from your API where applicable.

Acceptance:
- Clicking refresh produces deterministic folder + requests without duplicates.

---

## Phase 7: Backend compatibility mode (insomnia<->goulash backend)
Goal: keep original backend-driven workflow available.

Approach:
- Add environment variables in generated requests:
  - `{{ _.provider_backend_base_url }}`
  - `{{ _.provider_direct_base_url }}`
- Default backend base URL should be easy to set once per workspace/environment.

Acceptance:
- Switching env variable can route same request set to backend proxy or direct provider endpoints.

---

## Data Contracts (initial)

## Renderer <-> Main (IPC)
- `providerAuthInWindow.start({ providerId, loginUrl, successRules, domainFilters })`
- returns `{ status: 'success' | 'cancelled' | 'error', cookies?: ProviderCookie[], error?: string }`

## ProviderCookie
- `name`, `value`, `domain`, `path`, `expires?`, `secure?`, `httpOnly?`, `sameSite?`

---

## Testing Plan

## Unit tests
- Provider config validation (`provider-config.ts`).
- Cookie normalization + dedupe logic.
- Request generation idempotence.

## Integration/e2e smoke
- Popup opens and closes cleanly on cancel.
- Successful login returns cookies and persists provider session.
- Sync to cookie jar updates request behavior.
- Refresh endpoint queries is idempotent.

## Manual checks
- Kosik login path specifically.
- Existing OAuth/login flows unaffected.
- Existing cookie editor unaffected.

---

## Risks + Mitigations
- Provider login DOM/redirect changes:
  - keep success matching configurable per provider.
- Cookie extraction misses subdomains:
  - use domain allowlist with wildcard support.
- Endpoint drift:
  - manifest kept centralized; refresh operation designed for frequent updates.

---

## Rollout Strategy
1. Ship Phase 0-5 first (login + cookies + UI).
2. Ship Phase 6 request generation with Kosik seed endpoints.
3. Expand provider endpoint manifests iteratively.

---

## Execution Order (recommended)
1. Phase 0 cleanup.
2. Phase 1 provider config/types.
3. Phase 2 popup cookie capture IPC.
4. Phase 3 provider session model.
5. Phase 4 cookie sync.
6. Phase 5 UI modal wiring.
7. Phase 6 request generation.
8. Tests + polish.

