# Plan: fixes before 0.5.0

Decided by the owner; each is one commit, `npm test` green, tests first.

1. **One value type across the two libraries.** Export `EditValue = string | number | bigint |
   boolean | null` (Cascata's own name and members) and use it in `Writer.write`, `session.stage`,
   `StagedEdit.value`. Red first: a `// @ts-expect-error` on staging an object, and an unannotated
   arrow-function wrapper around Cascata's `yamlWriter()` assigned to `Writer` (both fail `tsc`
   while the type is `unknown`).
2. **Overlap rechecked after a rebase.** A test writer whose `write` answers overlapping ranges once
   the bytes change. After a rebase, of two overlapping staged edits the later-staged is conflicted
   (dropped, reported in `Change.edits`, and in the commit report). Red first.
3. **Three untested edges.** (a) `editTarget` then `stage` then `commit` on a real disk under
   `os.tmpdir()` without `realpath` (macOS `/var` is a symlink). (b) A read pass whose read races a
   commit. (c) Cases 4 and 8 of the joining milestone read back through `parse`.
4. **Case on macOS.** A `writable` root in another letter case than the disk still contains its
   files, because `canonicalize` answers the true spelling. The file system's case folding is
   probed in a temporary directory, never inferred from the platform name.

Sabotage each; report in `report.md`.
