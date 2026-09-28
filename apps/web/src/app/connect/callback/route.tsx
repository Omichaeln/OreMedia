import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { Button, StatusBanner } from '@oremedia/ui';
import { TopBar } from '../../root';
import { brandPath } from '../../../features/brand/brand-context';
import { recallConnect, returnQuery } from '../../../features/publishing/channel-connect';

/**
 * Spec 14.7: the one callback registered with Meta and LinkedIn. It only routes: the brand that started the flow
 * (remembered in this browser under its `state`) gets the provider's answer on its settings page, where finishing
 * the connection stays an explicit step. Nothing is exchanged here.
 */
export function ConnectCallbackRoute() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const state = params.get('state');
  const providerError = state ? null : params.get('error');
  // Read once: recallConnect removes the entry, and a re-render must not lose it.
  const [pending] = useState(() => (state ? recallConnect(state) : null));
  if (pending)
    return (
      <Navigate
        to={`${brandPath(pending.companyId, pending.brandId, 'settings')}?${returnQuery(search)}`}
        replace
      />
    );
  return (
    <>
      <TopBar title="Connect a channel" />
      <main id="main" className="mx-auto w-full max-w-lg p-6">
        <h1 className="mb-4 text-xl font-semibold">Connect a channel</h1>
        <StatusBanner
          tone="warning"
          title={
            providerError
              ? 'The provider did not authorise the connection'
              : 'This connection cannot be finished here'
          }
          description={
            providerError
              ? `${providerError}. Open the brand's Settings, Channels, and connect again.`
              : "It was started in another browser or on another address of this app, or it expired. Open the brand's Settings, Channels, and connect again from this browser."
          }
          actions={
            <Button size="sm" asChild>
              <Link to="/portfolio">Go to your brands</Link>
            </Button>
          }
          data-testid="connect-callback-unknown"
        />
      </main>
    </>
  );
}
