import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { ReviewPortalRoute } from './app/review-portal/route';
import { DeploymentBrandProvider, loadDeploymentBrand } from './lib/deployment-brand';

/** Separate build target (spec 21.1): served from REVIEW_PORTAL_ORIGIN so reviewer links never share app cookies. */
const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
void loadDeploymentBrand().then((brand) => {
  document.title = `${brand.name} review`;
  createRoot(root).render(
    <StrictMode>
      <DeploymentBrandProvider value={brand}>
        <ReviewPortalRoute standalone />
      </DeploymentBrandProvider>
    </StrictMode>,
  );
});
