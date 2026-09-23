# Provenance

A library that knows, for one rendered document, every source file involved, how those files depend on each other, where each rendered thing came from, and how to write changes back to disk. It runs in any JavaScript realm: it performs no I/O of its own and asks a host for everything outside the call.

**Status: nothing is built.** The project is at its vision.

- [Vision](docs/vision.md): what it is for, who it serves, what it is not.
- [Design principles](docs/principles.md): how it decides things, each principle with what it forbids.
- [Design synthesis](docs/design-synthesis.md): the day-zero design the vision was drawn from.
