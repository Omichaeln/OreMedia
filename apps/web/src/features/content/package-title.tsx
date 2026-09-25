import { usePackage } from './use-content';

/** A content package named by its title; its id until the package loads (or when it cannot be read). */
export function PackageTitle({ contentPackageId }: { contentPackageId: string }) {
  const pkg = usePackage(contentPackageId);
  return <>{pkg.data?.title ?? contentPackageId}</>;
}
