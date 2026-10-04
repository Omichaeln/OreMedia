import { agentsCases } from './agents';
import { corePlatformCases } from './core-platform';
import { corePublishingCases } from './core-publishing';
import { ingestCases } from './ingest';
import { renderMediaCases } from './render-media';
import type { RecordingCase } from './types';

/** Every recording case (spec 19.4). The recorder only adds histories for cases whose file does not exist yet. */
export const RECORDING_CASES: RecordingCase[] = [
  ...corePublishingCases,
  ...corePlatformCases,
  ...agentsCases,
  ...ingestCases,
  ...renderMediaCases,
];
