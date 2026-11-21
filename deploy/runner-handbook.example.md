# Project runner handbook

This handbook is maintained outside the target repository by its operator. Do not put credentials, customer records, or database connection strings here: instructions may be passed to the configured model provider.

## Project layout

- Primary repository: `OWNER/REPO` (must match the runner binding).
- Application entry point: fill in the relevant directory and files.
- Supported runtime and package manager: specify versions from the project's lockfile.

## Verification

- Install command: fill in the project's reproducible install command.
- Fast test: specify the smallest test demonstrating the expected behavior.
- Regression checks: list the commands and representative input cases.
- Never claim a test passed when a dependency, service or permission was missing.

## Data access

Use synthetic fixtures for tests. No production database connection is provided by default. When a check needs unavailable data, report exactly which evidence is missing. Do not include raw customer data in a task comment.

## Deliverable

Report the revision checked, commands actually run, expected vs. observed behavior, and any checks that remain unverified. This runner is not authorized to push, merge or deploy.
