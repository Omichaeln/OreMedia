import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import './styles/app.css';
import { createAppRouter } from './app/router';
import { DeploymentBrandProvider, loadDeploymentBrand } from './lib/deployment-brand';
import { createQueryClient } from './lib/query-client';
import { TRPCProvider, createClient, createOptionsProxy, keyPrefixFor } from './lib/trpc';

const queryClient = createQueryClient();
const client = createClient();
const router = createAppRouter({
  trpcFor: (tenantId) => createOptionsProxy(client, queryClient, tenantId),
  queryClient,
});

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
void loadDeploymentBrand().then((brand) => {
  document.title = brand.name;
  createRoot(root).render(
    <StrictMode>
      <DeploymentBrandProvider value={brand}>
        <QueryClientProvider client={queryClient}>
          <TRPCProvider trpcClient={client} queryClient={queryClient} keyPrefix={keyPrefixFor(null)}>
            <RouterProvider router={router} />
          </TRPCProvider>
        </QueryClientProvider>
      </DeploymentBrandProvider>
    </StrictMode>,
  );
});
