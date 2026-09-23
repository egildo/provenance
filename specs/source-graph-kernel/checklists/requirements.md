# Specification Quality Checklist: Source graph kernel

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-23
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- The reader is an embedder, a developer tool, so "non-technical stakeholders" is read as "an
  embedder who knows the glossary". SHA-256, UTF-8 bytes, Node and Cascata's host contract appear
  because the vision settles them as product facts, not as implementation choices.
- Clarified 2026-09-23: the kernel ships CSS and HTML handlers (`ship-css-handler`,
  `ship-html-handler`); a session has one entry plus embedder-added roots, and host reads by
  others become roots (`embedder-adds-roots`, glossary gains **Root**); scripts stay unread, as
  the vision says.
- Not yet reconciled: the vision's definition of a session ("one entry document, everything
  reachable from it") does not mention roots. Amending the vision is its own act; see the
  completion report.
