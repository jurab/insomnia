import React, { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';

import { syncProviderCookiesToWorkspace } from '~/provider-explorer/cookie-sync';
import { generateOrRefreshProviderRequests } from '~/provider-explorer/generate-requests';
import { getProviderConfig, providerConfigList } from '~/provider-explorer/provider-config';
import { getProviderSession, saveProviderSession } from '~/provider-explorer/provider-session-store';
import type { ProviderId } from '~/provider-explorer/types';
import { Icon } from '~/ui/components/icon';

interface Props {
  isOpen: boolean;
  onClose: (isOpen: boolean) => void;
  organizationId: string;
  workspaceId: string;
}

export const ProviderExplorerModal = ({ isOpen, onClose, organizationId, workspaceId }: Props) => {
  const [providerId, setProviderId] = useState<ProviderId>('kosik');
  const [cookieCount, setCookieCount] = useState(0);
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [status, setStatus] = useState<string>('');
  const [isWorking, setIsWorking] = useState(false);

  const providerConfig = useMemo(() => getProviderConfig(providerId), [providerId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const loadSession = async () => {
      const session = await getProviderSession(organizationId, providerId);
      if (!session) {
        setCookieCount(0);
        setCapturedAt(null);
        return;
      }

      setCookieCount(session.cookies.length);
      setCapturedAt(session.capturedAt);
    };

    void loadSession();
  }, [isOpen, organizationId, providerId]);

  const handleLogin = async () => {
    setIsWorking(true);
    setStatus('Opening provider login popup...');
    try {
      const result = await window.main.providerAuthInWindow.start({
        providerId,
        loginUrl: providerConfig.auth.loginUrl,
        successRules: providerConfig.auth.successRules,
        domainFilters: providerConfig.auth.domainFilters,
      });

      if (result.status === 'cancelled') {
        setStatus('Login cancelled.');
        return;
      }

      if (result.status === 'error') {
        setStatus(`Login failed: ${result.error || 'unknown error'}`);
        return;
      }

      const cookies = result.cookies || [];
      await saveProviderSession({
        organizationId,
        providerId,
        cookies,
      });
      setCookieCount(cookies.length);
      setCapturedAt(Date.now());
      setStatus(`Captured ${cookies.length} cookies.`);
    } catch (error) {
      setStatus(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsWorking(false);
    }
  };

  const handleSyncCookies = async () => {
    setIsWorking(true);
    setStatus('Syncing provider cookies into workspace cookie jar...');
    try {
      let session = await getProviderSession(organizationId, providerId);
      if (!session) {
        const getPersistedCookies = window.main.providerAuthInWindow?.getPersistedCookies;
        let recoveredCookies =
          typeof getPersistedCookies === 'function'
            ? await getPersistedCookies({
                providerId,
                domainFilters: providerConfig.auth.domainFilters,
              })
            : [];

        // If no session/cookies are available, run popup flow and try recovering again.
        if (!recoveredCookies.length) {
          setStatus('No saved provider session found. Opening popup to capture cookies...');
          const popupResult = await window.main.providerAuthInWindow.start({
            providerId,
            loginUrl: providerConfig.auth.loginUrl,
            successRules: providerConfig.auth.successRules,
            domainFilters: providerConfig.auth.domainFilters,
          });

          if (popupResult.status === 'success' && popupResult.cookies?.length) {
            recoveredCookies = popupResult.cookies;
          } else if (typeof getPersistedCookies === 'function') {
            recoveredCookies = await getPersistedCookies({
              providerId,
              domainFilters: providerConfig.auth.domainFilters,
            });
          }
        }

        if (!recoveredCookies.length) {
          setStatus('No provider session found and no persisted cookies available. Run login first.');
          return;
        }

        session = await saveProviderSession({
          organizationId,
          providerId,
          cookies: recoveredCookies,
        });
        setCookieCount(session.cookies.length);
        setCapturedAt(session.capturedAt);
      }

      const syncResult = await syncProviderCookiesToWorkspace({
        workspaceId,
        cookies: session.cookies,
      });
      setStatus(
        `Synced ${syncResult.importedCookieCount} cookies. Workspace jar now has ${syncResult.totalCookieCount}.`,
      );
    } catch (error) {
      setStatus(`Cookie sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsWorking(false);
    }
  };

  const handleGenerateRequests = async () => {
    setIsWorking(true);
    setStatus('Generating direct endpoints...');
    try {
      const result = await generateOrRefreshProviderRequests({
        workspaceId,
        providerId,
      });
      setStatus(`Generated ${result.created}, updated ${result.updated}, total ${result.total}.`);
    } catch (error) {
      setStatus(`Request generation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <ModalOverlay
      isOpen={isOpen}
      isDismissable
      onOpenChange={onClose}
      className="fixed top-0 left-0 z-20 flex h-(--visual-viewport-height) w-full items-center justify-center bg-black/40"
    >
      <Modal className="flex w-full max-w-2xl flex-col rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) p-(--padding-lg) text-(--color-font)">
        <Dialog className="flex flex-col gap-4 outline-hidden">
          {({ close }) => (
            <>
              <div className="flex items-center justify-between gap-2">
                <Heading slot="title" className="text-2xl">
                  Provider Explorer
                </Heading>
                <Button
                  className="flex aspect-square h-6 items-center justify-center rounded-xs text-sm text-(--color-font) ring-1 ring-transparent transition-all hover:bg-(--hl-xs) focus:ring-(--hl-md) focus:ring-inset aria-pressed:bg-(--hl-sm)"
                  onPress={close}
                >
                  <Icon icon="x" />
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span>Provider</span>
                  <select
                    className="rounded-xs border border-solid border-(--hl-sm) bg-(--color-bg) px-2 py-1"
                    value={providerId}
                    onChange={e => setProviderId(e.target.value as ProviderId)}
                  >
                    {providerConfigList.map(provider => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="flex flex-col gap-1 text-sm text-(--color-font-secondary)">
                <div>Cookies captured: {cookieCount}</div>
                <div>Last captured: {capturedAt ? new Date(capturedAt).toLocaleString() : 'never'}</div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  isDisabled={isWorking}
                  onPress={handleLogin}
                  className="rounded-xs border border-solid border-(--hl-md) px-3 py-2 text-sm font-semibold transition-colors hover:bg-(--hl-xs) disabled:opacity-50"
                >
                  Login via popup
                </Button>
                <Button
                  isDisabled={isWorking}
                  onPress={handleSyncCookies}
                  className="rounded-xs border border-solid border-(--hl-md) px-3 py-2 text-sm font-semibold transition-colors hover:bg-(--hl-xs) disabled:opacity-50"
                >
                  Sync cookies to this workspace
                </Button>
                <Button
                  isDisabled={isWorking}
                  onPress={handleGenerateRequests}
                  className="rounded-xs border border-solid border-(--hl-md) bg-(--color-surprise) px-3 py-2 text-sm font-semibold text-(--color-font-surprise) transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  Generate/Refresh endpoint queries
                </Button>
              </div>

              <div className="min-h-6 rounded-xs border border-solid border-(--hl-sm) bg-(--hl-xs) px-2 py-1 text-sm">
                {status || 'Ready.'}
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};
