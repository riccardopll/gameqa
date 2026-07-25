# GameQA release plan

This file tracks the local-first product work. Checked items are implemented and verified locally.

## 1. Repository cleanup

- [x] Remove the abandoned landing-page build and stale web package artifacts.
- [x] Remove local OS/build artifacts and stale Git worktree metadata.
- [x] Add clear repository documentation and development commands.
- [x] Make internal workspace package names and dependencies explicit.
- [x] Add a repeatable clean command.

## 2. Pi agent adapter

- [x] Replace the Codex-only configuration with a Pi adapter.
- [x] Invoke Pi non-interactively with tools and project resources disabled.
- [x] Send prompts over stdin and handle spawn failures/timeouts cleanly.
- [x] Parse and validate schema-constrained JSON responses.
- [x] Support optional Pi provider, model, and thinking settings.
- [x] Unit-test Pi command construction, JSON parsing, stdin, errors, and timeouts.
- [x] Complete a real model-backed demo run through the installed Pi CLI.

## 3. Reliable run loop and evidence

- [x] Authenticate every local bridge request and validate run/session IDs.
- [x] Bound bridge request body sizes.
- [x] Distinguish agent finish, max-turn, timeout, and failure completion reasons.
- [x] Add configurable settling after game actions.
- [x] Include browser logs and screenshot text/images in final report generation.
- [x] Remove duplicate temporary video artifacts.
- [x] Add useful CLI help, version, and non-zero invalid-command behavior.

## 4. Demo game

- [x] Build a small instrumented game as a workspace package.
- [x] Demonstrate controller actions, driver goals/scenarios, events, metrics, and errors.
- [x] Include an intentional economy bug that GameQA can find.
- [x] Document how to run and manually inspect the demo.

## 5. End-to-end verification

- [x] Add a deterministic fake Pi executable for CI.
- [x] Exercise demo game → SDK → Docker runner → bridge → decisions → report.
- [x] Assert screenshots, state/events, actions, video, trace, logs, and report contents.
- [x] Provide separate fast unit and full Docker E2E commands.
- [x] Run the full E2E test locally.

## 6. CI and release readiness

- [x] Add CI for install, format, lint, typecheck, unit tests, build, pack, and E2E.
- [x] Gate browser-runner publishing on checks.
- [x] Publish immutable version/SHA image tags as well as `latest` in workflows.
- [x] Add an npm release workflow with provenance and GitHub release artifacts.
- [x] Pin the default runner image to the CLI package version.
- [x] Verify the npm tarball from a clean consumer fixture.
- [x] Document release prerequisites and process.

## External release activation

These require repository-owner credentials and cannot be completed from the current unauthenticated machine:

- [x] Re-authenticate the GitHub CLI or push through an authenticated Git remote.
- [x] Configure npm trusted publishing for `gameqa` (or add `NPM_TOKEN`).
- [ ] Push the changes and let the main-branch CI/publish workflow pass.
- [ ] Push tag `v0.1.0`; verify npm, GHCR version tag, and GitHub release publication.

## Later

- [ ] Native arm64 browser-runner image.
- [ ] Split the remaining large SDK, runner, and contracts modules after E2E coverage is stable.
- [ ] Add more demo scenarios and adapter implementations without weakening the Pi path.
