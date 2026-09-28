import { cn } from '@oremedia/ui';
import { useDeploymentBrand } from '../lib/deployment-brand';

/**
 * D-12: the deployment's logo where there is room for a full lockup (sign-in, the review portal). The name stays the
 * accessible label; a deployment without a logo renders nothing here and its name appears in the heading instead.
 */
export function DeploymentLogo({ className }: { className?: string }) {
  const { name, logo } = useDeploymentBrand();
  if (!logo) return null;
  return (
    <span className={cn('block', className)} role="img" aria-label={name}>
      <img src={logo.light} alt="" className="deployment-logo-light h-full w-auto" />
      <img src={logo.dark} alt="" className="deployment-logo-dark h-full w-auto" />
    </span>
  );
}
