import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, EmptyState, PageHeader, Skeleton, StatusDot, toneGlyph, type Tone } from '@oremedia/ui';
import { Drawer, DrawerContent } from '../../components/drawer';
import { RequestError } from '../../components/request-state';
import { GroupHeader } from '../../components/section';
import { Tab, TabList, TabPanel, Tabs } from '../../components/tabs';
import { toUiError } from '../../lib/errors';
import { useBrandContext } from '../brand/brand-context';
import { ChannelSettings } from '../publishing/channel-settings';
import { DestinationSettings } from '../destinations/destination-settings';
import { useCompanies } from '../portfolio/use-companies';
import { BrandType, KillSwitches, ModelRouting, ReleasePolicy } from './admin-controls';
import { AppearanceSettings } from './appearance-settings';
import { BudgetsSettings } from './budgets-settings';
import { Mandates, Members } from './members-mandates';
import { SkillDetail, SkillImportForm } from './skill-detail';
import { useSkills, type SkillDto } from './use-settings';

const TAB_PARAM = 'tab';
/** The interface's seven tabs; the third column marks the ones owners and admins alone see. */
const TABS = [
  ['channels', 'Channels', false],
  ['mandates', 'Mandates', false],
  ['policy', 'Release policy', false],
  ['skills', 'Skills', false],
  ['members', 'Members', true],
  ['budgets', 'Budgets & models', true],
  ['appearance', 'Appearance', false],
] as const;
type SettingsTab = (typeof TABS)[number][0];
/**
 * The tabs the application had before the interface's set, so their deep links keep opening the same content:
 * Destinations is the "Websites and sources" group of Channels, Model routing sits under "Budgets & models", and
 * Account (the password) under "Appearance".
 */
const FORMER_TABS: Record<string, SettingsTab> = {
  destinations: 'channels',
  routing: 'budgets',
  account: 'appearance',
};

/** Owners and admins hold audit.read and billing.manage (the kill switches and model routing); the server re-checks. */
const ADMIN_ROLES = new Set(['owner', 'admin']);
/** Who may activate a release policy, and so change the brand type (brand.publish_version). */
const POLICY_ROLES = new Set(['owner', 'admin', 'brand_manager']);
/** Who may register and disconnect a destination (destination.connect / destination.manage, as channels). */
const DESTINATION_ROLES = new Set(['owner', 'admin', 'publisher']);

const SCOPE_LABEL: Record<SkillDto['scope'], string> = {
  platform: 'Built in',
  tenant: 'Company',
  brand: 'This brand',
};

const skillChip = (s: SkillDto): { tone: Tone; label: string } =>
  s.state === 'retired'
    ? { tone: 'neutral', label: 'Retired' }
    : s.activeVersionId
      ? { tone: 'good', label: 'Published' }
      : { tone: 'warning', label: 'No published version' };

/**
 * Spec 9: the skills agents may run for this brand; a version runs only once evaluated and published by a person.
 * UX-17: a skill opens in a side sheet with its versions and the lifecycle actions; a package is imported here.
 * Rows as the interface lists them: key and title, a dot with the state, who it is for.
 */
function SkillsSettings() {
  const { brandId } = useBrandContext();
  const skills = useSkills();
  const [openId, setOpenId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Another brand's own skills are not this brand's to run.
  const visible = (skills.data?.items ?? []).filter((s) => s.brandId === null || s.brandId === brandId);
  return (
    <section aria-labelledby="skills-heading" className="flex flex-col gap-5" data-testid="skills">
      <GroupHeader
        id="skills-heading"
        title="Skills"
        description="Declarative packages agents run. A version runs only after its evaluations pass and a person publishes it; brand skills are imported from the brand system."
      />
      {skills.isPending && <Skeleton label="Loading skills" lines={3} />}
      {skills.isError && (
        <RequestError
          error={skills.error}
          onRetry={() => void skills.refetch()}
          title={toUiError(skills.error).kind === 'forbidden' ? 'Permission denied' : undefined}
        />
      )}
      {skills.isSuccess && visible.length === 0 && (
        <EmptyState title="No skills" description="No skill is visible to this brand yet." />
      )}
      {visible.length > 0 && (
        <ul className="flex flex-col" aria-label="Skills">
          {visible.map((s) => {
            const chip = skillChip(s);
            return (
              <li
                key={s.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-border py-3 sm:grid-cols-[minmax(0,1fr)_150px_110px]"
              >
                <button
                  type="button"
                  className="min-w-0 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setOpenId(s.id)}
                  aria-label={`Open ${s.title}`}
                >
                  <p className="text-sm tabular-nums">
                    <code>{s.key}</code>
                  </p>
                  <p className="text-xs text-muted-foreground">{s.title}</p>
                </button>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusDot tone={chip.tone} size="sm" />
                  <span className="sr-only">{toneGlyph[chip.tone]} </span>
                  {chip.label}
                </span>
                <span className="col-span-full text-xs text-muted-foreground sm:col-span-1 sm:text-right">
                  {SCOPE_LABEL[s.scope]}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {skills.data?.nextCursor && (
        <p className="text-xs text-muted-foreground">More skills exist than are shown here.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setImporting((v) => !v)}
          aria-expanded={importing}
        >
          Import SKILL.md package
        </Button>
        <span className="text-xs text-muted-foreground">
          Declarative only. Evaluations must pass before publish.
        </span>
      </div>
      {importing && <SkillImportForm brandId={brandId} />}
      <Drawer open={openId !== null} onOpenChange={(open) => !open && setOpenId(null)}>
        <DrawerContent title="Skill" side="right" className="w-[min(92vw,30rem)] overflow-y-auto p-5">
          {openId && <SkillDetail skillId={openId} brandId={brandId} />}
        </DrawerContent>
      </Drawer>
    </section>
  );
}

/**
 * Spec 21.1 `settings/`: the brand's settings as the interface's tabs, the tab in the URL. Channels also holds the
 * websites and sources (destinations); Release policy the brand type, the policy in force and the kill switches;
 * Budgets & models the spend limits, the ledger and the model routing (owners and admins); Appearance the theme and
 * the signed-in person's own password, whatever their role.
 */
export function SettingsScreen() {
  const { companyName, companyId, brand } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const companies = useCompanies();
  const role = companies.data?.find((c) => c.tenantId === companyId)?.role ?? null;
  const isAdmin = role !== null && ADMIN_ROLES.has(role);
  const tabs = TABS.filter(([, , adminOnly]) => !adminOnly || isAdmin);
  const raw = params.get(TAB_PARAM);
  const wanted = raw === null ? 'channels' : (FORMER_TABS[raw] ?? raw);
  const tab: SettingsTab = tabs.some(([k]) => k === wanted) ? (wanted as SettingsTab) : 'channels';
  const panel = 'om-in';

  return (
    <main
      id="main"
      className="om-in mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 py-8 sm:px-10 sm:pb-20 sm:pt-10"
    >
      <PageHeader title="Settings" description={`${brand.name} · ${companyName ?? companyId}`} />
      <Tabs
        value={tab}
        onValueChange={(v) => setParams({ [TAB_PARAM]: v }, { replace: true })}
        className="flex flex-col gap-6"
      >
        <TabList label="Settings sections">
          {tabs.map(([k, label]) => (
            <Tab key={k} value={k}>
              {label}
            </Tab>
          ))}
        </TabList>
        <TabPanel value="channels" className={`${panel} flex flex-col gap-8`}>
          <ChannelSettings />
          <div className="flex flex-col gap-5 border-t border-border pt-6">
            <GroupHeader
              id="websites-heading"
              title="Websites and sources"
              description={`The website, analytics, search and Business Profile sources ${brand.name} reads from and publishes beyond social.`}
            />
            <DestinationSettings
              canManage={isAdmin}
              canConnectDestinations={role !== null && DESTINATION_ROLES.has(role)}
              canManageDestinations={role !== null && DESTINATION_ROLES.has(role)}
            />
          </div>
        </TabPanel>
        <TabPanel value="mandates" className={panel}>
          <Mandates canManage={isAdmin} />
        </TabPanel>
        <TabPanel value="policy" className={`${panel} flex flex-col gap-8`}>
          <BrandType canManage={role !== null && POLICY_ROLES.has(role)} />
          <ReleasePolicy canManage={role !== null && POLICY_ROLES.has(role)} />
          {isAdmin && <KillSwitches />}
        </TabPanel>
        <TabPanel value="skills" className={panel}>
          <SkillsSettings />
        </TabPanel>
        {isAdmin && (
          <TabPanel value="members" className={panel}>
            <Members />
          </TabPanel>
        )}
        {isAdmin && (
          <TabPanel value="budgets" className={`${panel} flex flex-col gap-8`}>
            <BudgetsSettings enabled={isAdmin} />
            <ModelRouting />
          </TabPanel>
        )}
        <TabPanel value="appearance" className={panel}>
          <AppearanceSettings />
        </TabPanel>
      </Tabs>
    </main>
  );
}
