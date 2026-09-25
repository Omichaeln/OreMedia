# ADR-06: Reference codebase used as reference only; no code copied unless the AGPL route or a separate licence is accepted; Polotno only with written permission

**Status:** Accepted (programme owner, 25 September 2026)
**Date:** 23 September 2026

## Context

The reference codebase studied in spec section 20 is AGPL-3.0. Copying source makes Oremedia a derivative with network-source obligations.

## Decision (default)

Clean implementation using the reference codebase as an architectural reference. The refactor map (spec 20.2) names what is ported
as a pattern. No code marked "port as code" is copied until this ADR records acceptance of AGPL or a separate
licence from the copyright holders, with attribution and licence headers preserved.

## Status of this build

Nothing has been copied. Files marked "ported as pattern" were re-derived from the specification's description.
