# LingoSofa Contributor Guidelines

These guidelines apply to the entire repository. The technical plan is in [docs/lingo-sofa-plan.md](docs/lingo-sofa-plan.md).

## Commit Conventions

- Use Conventional Commits: `<type>(<scope>): <description>`. The scope is optional.
- Common types are `feat`, `fix`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `perf`, and `style`.
- Write commit messages in English. Keep the description concise and specific, for example `docs: clarify contributor guidelines` or `fix(translation-core): discard stale translation results`.
- Give each commit one clear purpose. Do not mix unrelated refactoring, formatting, or temporary files into the same commit.
- Mark breaking changes with `!` and explain their impact and migration steps in a `BREAKING CHANGE:` footer.
- Review the staged diff before committing. Exclude secrets, credentials, debug artifacts, and unintended changes.

## Pre-commit Verification

- Lint and formatting checks must pass before committing. Use the repository scripts; editor formatting alone is insufficient.
- Run tests for the changed behavior and affected consumers. Changes to shared code or protocols require checks of the relevant consumers, not just the edited files.
- Add regression tests for bug fixes and update tests for behavior changes. Documentation-only changes do not require code tests, but Markdown formatting, links, and file references must be checked.
- Changes to types, build configuration, or dependencies also require type checks and builds for the affected components.
- Fix failures and rerun the checks. Do not bypass checks, disable rules, or delete valid tests to make a change pass.
- Run `npm run check` before committing. It runs lint, formatting checks, type checks, tests, and configured builds. Use `npm test -- <file-path>` to target relevant tests. The initial scaffold may have no tests; business logic must have meaningful tests, and the absence of tests is not evidence that behavior is correct.
- Report the checks performed and their results. Explain any checks that were not run.

## Architecture and Code Quality

- Keep the architecture clear: each module has one responsibility, dependencies have an explicit direction, and modules interact through public interfaces.
- Keep the shared core independent of its host. It must not depend on browser APIs, Discord internals, or Node-specific implementations. Inject network, storage, credential, and logging interfaces.
- Keep coupling low. Avoid circular dependencies, access to another layer's internals, and shared mutable global state connecting modules.
- Prefer simple, direct, readable implementations. Introduce abstractions to remove actual duplication or isolate a clear boundary, not to anticipate hypothetical needs.
- Remove redundant code, dead branches, temporary debugging logic, and duplicate implementations. Compatibility code must have a clear purpose and supported scope.
- Use names that express domain meaning and define clear types and error boundaries. Comments should explain necessary constraints and tradeoffs rather than repeat the code.
- Keep changes focused. Refactor only as needed for the current task, preserve verifiable behavior, and avoid rewriting unrelated modules.
- Test observable behavior, edge cases, and failure paths. Avoid tests that merely mirror implementation details or add little value for low-impact changes.

## Documentation

- Keep `docs/` for maintained user guides, contributor guides, architecture, product/design decisions, and reusable acceptance criteria. Do not add per-run logs, benchmark results, artifact hashes, or progress diaries.
- Write generated previews and local validation reports to `.cache/`; publish CI reports as workflow artifacts. Summarize check results in commit or pull request descriptions.
- Store README screenshots in `assets/screenshots/` and reusable test inputs in `tests/fixtures/`. Keep editable design sources; omit duplicate exports and archives.
- Update references when moving or removing documents. Preserve known compatibility limits and pending acceptance items without presenting historical checks as current results.
