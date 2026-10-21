# Repository workflow

- After completing each round of code changes, run the relevant checks and create a local Git commit. This is the user's standing preference.
- Report the commit hash and validation results. Distinguish local commits from pushes to the remote repository.
- Never commit API keys, credentials, local conversation data, dependencies, or generated build artifacts.
- Keep Web UI, server, desktop shell, shared types, and provider adapters in their respective directories; update design documentation when behavior changes.
