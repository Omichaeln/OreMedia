import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Button, EmptyState, Skeleton, type Tone } from '@oremedia/ui';
import { Drawer, DrawerContent } from '../../components/drawer';
import { RequestError } from '../../components/request-state';
import { Section } from '../../components/section';
import { Tab, TabList, TabPanel, Tabs } from '../../components/tabs';
import { toUiError } from '../../lib/errors';
import { useBrandContext } from '../brand/brand-context';
import { ChannelSettings } from '../publishing/channel-settings';
import { DestinationSettings } from '../destinations/destination-settings';
import { AccountPassword } from '../session/account-password';
import { useCompanies } from '../portfolio/use-companies';
import { BrandType, KillSwitches, ModelRouting, ReleasePolicy } from './admin-controls';
import { BudgetsSettings } from './budgets-settings';
import { Mandates, Members } from './members-mandates';
import { SkillDetail, SkillImportForm } from './skill-detail';
import { useSkills, type SkillDto } from './use-settings';

const TAB_PARAM = 'tab';
const TABS = [
  ['channels', 'Channels', false],
  ['destinations', 'Destinations', false],
  ['mandates', 'Mandates', false],
  ['policy', 'Policy', false],
  ['skills', 'Skills', false],
  ['members', 'Members', true],
  ['budgets', 'Budgets', true],
  ['routing', 'Model routing', true],
  ['account', 'Account', false],
] as const;
type SettingsTab = (typeof TABS)[number][0];

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
 */
function SkillsSettings() {
  const { brandId } = useBrandContext();
  const skills = useSkills();
  const [openId, setOpenId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Another brand's own skills are not this brand's to run.
  const visible = (skills.data?.items ?? []).filter((s) => s.brandId === null || s.brandId === brandId);
  return (
    <Section id="skills-heading" title="Skills" testId="skills">
      <p className="text-xs text-muted-foreground">
        Declarative packages agents run. A version runs only after its evaluations pass and a person publishes
        it; brand skills are imported from the brand system.
      </p>
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
        <ul className="flex flex-col divide-y divide-border" aria-label="Skills">
          {visible.map((s) => {
            const chip = skillChip(s);
            return (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
                <button
                  type="button"
                  className="min-w-0 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setOpenId(s.id)}
                  aria-label={`Open ${s.title}`}
                >
                  <p className="text-sm font-medium">{s.title}</p>
                  <p className="text-xs text-muted-foreground">
                    <code>{s.key}</code> · {SCOPE_LABEL[s.scope]}
                  </p>
                </button>
                <Badge tone={chip.tone}>{chip.label}</Badge>
              </li>
            );
          })}
        </ul>
      )}
      {skills.data?.nextCursor && (
        <p className="text-xs text-muted-foreground">More skills exist than are shown here.</p>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setImporting((v) => !v)}
          aria-expanded={importing}
        >
          Import a skill package
        </Button>
      </div>
      {importing && <SkillImportForm brandId={brandId} />}
      <Drawer open={openId !== null} onOpenChange={(open) => !open && setOpenId(null)}>
        <DrawerContent title="Skill" side="right" className="w-[min(92vw,30rem)] overflow-y-auto p-5">
          {openId && <SkillDetail skillId={openId} brandId={brandId} />}
        </DrawerContent>
      </Drawer>
    </Section>
  );
}

/**
 * Spec 21.1 `settings/`: the brand's settings as tabs (the v3 prototype's arrangement), the tab in the URL. Owners and
 * admins also see the members, budgets (spec 12.6 limits and the ledger), the kill switches (on Policy), mandate
 * actions and model routing. Account is the signed-in person's own (their password), whatever their role.
 */
export function SettingsScreen() {
  const { companyName, companyId, brand } = useBrandContext();
  const [params, setParams] = useSearchParams();
  const companies = useCompanies();
  const role = companies.data?.find((c) => c.tenantId === companyId)?.role ?? null;
  const isAdmin = role !== null && ADMIN_ROLES.has(role);
  const tabs = TABS.filter(([, , adminOnly]) => !adminOnly || isAdmin);
  const raw = params.get(TAB_PARAM);
  const tab: SettingsTab = tabs.some(([k]) => k === raw) ? (raw as SettingsTab) : 'channels';

  return (
    <main id="main" className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-8">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {brand.name} · {companyName ?? companyId}
        </p>
      </header>
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
        <TabPanel value="channels">
          <ChannelSettings />
        </TabPanel>
        <TabPanel value="destinations">
          <DestinationSettings
            canManage={isAdmin}
            canConnect={role !== null && DESTINATION_ROLES.has(role)}
          />
        </TabPanel>
        <TabPanel value="mandates">
          <Mandates canManage={isAdmin} />
        </TabPanel>
        <TabPanel value="policy" className="flex flex-col gap-8">
          <BrandType canManage={role !== null && POLICY_ROLES.has(role)} />
          <ReleasePolicy canManage={role !== null && POLICY_ROLES.has(role)} />
          {isAdmin && <KillSwitches />}
        </TabPanel>
        <TabPanel value="skills">
          <SkillsSettings />
        </TabPanel>
        {isAdmin && (
          <TabPanel value="members">
            <Members />
          </TabPanel>
        )}
        {isAdmin && (
          <TabPanel value="budgets">
            <BudgetsSettings enabled={isAdmin} />
          </TabPanel>
        )}
        {isAdmin && (
          <TabPanel value="routing">
            <ModelRouting />
          </TabPanel>
        )}
        <TabPanel value="account">
          <AccountPassword />
        </TabPanel>
      </Tabs>
    </main>
  );
}
