# Working on Provenance

Read `README.md`, `docs/principles.md`, `docs/glossary.md`, then `specs/HANDOFF.md` (the working method, the
invariants and the traps) before changing anything. The owner decides every semantic question; `docs/` and the kernel
spec change through the coordinator.

## Bump it up

The release drill, confirmed by the owner at 0.6.0. "Bump it up" approves exactly this.

1. Tree clean on `main` (an untracked `.claude/settings.local.json` excepted); `npm test` green, or stop.
2. If the round needs a newer Cascata, publish that first and raise the `@egildo/cascata` dev dependency
   (`npm install -D @egildo/cascata@^X.Y.Z`; `test/boundary.test.ts` pins its major and minor).
3. Bump `version` in `package.json` and add the release's entry at the top of `CHANGELOG.md`, dated, with its
   breaking changes named. Commit as `vX.Y.Z: <the round's name>`.
4. `git tag vX.Y.Z`, then `git push origin main vX.Y.Z`.
5. The push to Codeberg reaches the GitHub mirror, and `.github/workflows/publish.yml` publishes the tag to npmjs.org
   by trusted publishing (`prepublishOnly` tests and builds). Verify: origin `main` equals local, the tag is on
   origin, the run is green, `npm view @egildo/provenance version` answers the new version.
