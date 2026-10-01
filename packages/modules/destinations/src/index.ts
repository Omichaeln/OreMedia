// Brand destinations and source-use policy (ledger R2-0, D-16/D-17/D-18): the non-social places a brand reads
// from or writes to, registered with their owner, scopes, health and capability version, and the per-kind,
// per-data-type policy that says what the product may do with each source's data, versioned with a review date.
// Every write here is a person's: destination.connect, destination.manage and source_use.manage are AGENT_NEVER.
export { destinationService, sourceUsePolicyService } from './service';
export { BrandDestinationRepository, SourceUsePolicyRepository } from './repositories';
