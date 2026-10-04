import { Badge } from '@oremedia/ui';
import { CAPABILITY_LABEL, CAPABILITY_STATE_CHIP } from '../publishing/channel-connect';
import type { ProviderActivationDto } from './use-settings';

/**
 * PR-06: every certifiable capability of a listed provider with its state (certified, not certified, not
 * supported), so an uncertified capability is visibly so; the server refuses what is not certified.
 */
export function CapabilityCertifications({ activation }: { activation: ProviderActivationDto }) {
  if (activation.capabilities.length === 0) return null;
  return (
    <ul
      className="flex basis-full flex-wrap gap-1"
      aria-label={`Capability certification for ${activation.key}`}
      data-testid="capability-certifications"
    >
      {activation.capabilities.map((c) => {
        const chip = CAPABILITY_STATE_CHIP[c.state];
        return (
          <li key={c.capability} data-capability={c.capability} data-capability-state={c.state}>
            <Badge
              tone={chip.tone}
              title={
                c.certification
                  ? `Certified ${c.certification.certifiedAt.slice(0, 10)} in ${c.certification.environment}`
                  : undefined
              }
            >
              {CAPABILITY_LABEL[c.capability]}: {chip.label}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}
