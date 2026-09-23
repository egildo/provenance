# Provenance Constitution

This document governs how Provenance is engineered. What Provenance is and what it is for is
[the vision](../../docs/vision.md); how its design decides things is
[the design principles](../../docs/principles.md). Neither is restated here, and both outrank
this document.

## Core Principles

### Lean

The least code that does the job. Code exists because a spec asks for it, not because a future
might.

**Forbids:** an abstraction with one implementation; an option for a value that never varies;
code, hooks or extension points for a need no spec names; a runtime dependency for what a few
lines of standard JavaScript do.

**Why:** the library has to stay small enough to hold in one head, like its vision. Every line
added is a line every later reader carries.

### General over particular

Provenance is written for any tool that renders documents from files. Its first customers prove
it; they do not shape it.

**Forbids:** a consumer's name or conventions (BelType's include syntax, Cascata's cascade) in
library code; they appear only in tests, examples and documents. A special case for one
consumer in the core; it belongs behind a contract (handler, resolver, host, observer) or in the
consumer. A contract whose shape is only the shape of the one implementation that exists.

**Why:** the vision promises any tool. Cascata already shows the pattern: it meets the host
contract by shape, without importing Provenance.

### Strict TypeScript

TypeScript with `strict` on, erasable syntax only, shipped as ES modules with declarations. The
types are the contract and are checked, not hoped.

**Forbids:** `any` (use `unknown` and narrow); a cast or non-null assertion standing in for a
check the code could make; enums, namespaces and parameter properties, which type stripping
cannot erase; a CommonJS build.

**Why:** the type checker is the one reviewer that reads every line for free. Erasable syntax
lets the source run as written, with no build step between a test and the code it tests.

### Small public surface

Every export is a promise. The public API is exactly what a spec names.

**Forbids:** an export no spec names; exporting internals so a test can reach them; a second
way to do what one function already does.

**Why:** an export not added costs nothing; an export removed is a breaking change for every
consumer.

### Every mechanism leaves a check

Non-trivial logic ships with the smallest test that fails when the logic breaks. A worked
example in a document is run as a test before it is committed.

**Forbids:** a mechanism no failing test guards; a test that asserts against a stub standing in
for vocabulary that does not exist yet; mocks of the host where an in-memory host, which is a
real host, would do.

**Why:** a worked example that was never run can carry two readings and look settled in both.
Tests through real contracts prove the contracts, not the mocks.

## Technology constraints

- **Language:** TypeScript, `strict`, `erasableSyntaxOnly`, ES modules only. Published as
  `@egildo/provenance` (see [the vision](../../docs/vision.md)).
- **Platform:** library code uses standard ECMAScript and only the globals common to Node,
  browsers and workers. The `node:` boundary is the design principle *Supply, not meaning*.
- **Build:** `tsc`, and nothing else until a plan justifies more.
- **Tests:** Node's built-in `node:test` runner, running TypeScript by type stripping. Test
  files may import `node:`; library files may not.
- **Dependencies:** zero runtime dependencies in the core. A parser belongs to the handler that
  needs it, never to the core. Every dependency is named and justified in the plan that adds it.

## Development workflow

- **Documents move first.** A round states its purpose, amends the documents (spec, glossary,
  and the vision or principles only on purpose), then makes the code agree, on one branch.
- **Checked by name.** Every plan's Constitution Check names each principle here and each
  design principle, with a pass or a justified exception. A decision that contradicts one means
  one of the two is wrong: name which, and settle it before code.
- **Requirements are named, not numbered.** Two to four kebab-case words naming the obligation
  (`reject-invalid-utf8`), chosen once and kept; never `FR-016`.
- **Said once.** Specs and plans link to the vision, principles and glossary rather than
  restating them. A new term enters [the glossary](../../docs/glossary.md) in the same branch.
- **Agreement before landing.** Before a branch lands, the documents it touched are read against
  each other and against the code.

## Governance

Precedence, highest first: the vision (on scope), the design principles (on method), this
constitution (on engineering practice), then specs, plans and tasks. None is overridden by
anything below it or by convenience.

Amending this constitution is its own act, on its own branch, with its reason recorded. It never
happens as a side effect of other work. Versions follow semantic versioning: MAJOR for removing
or redefining a principle, MINOR for adding a principle or section or materially widening one,
PATCH for wording. Exceptions to a principle are recorded in the plan's Complexity Tracking with
the simpler alternative and why it fails.

**Version**: 1.0.0 | **Ratified**: 2026-09-23 | **Last Amended**: 2026-09-23
