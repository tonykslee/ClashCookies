# Git Aliases for This Repo Workflow

Add these aliases once on your machine to reduce repeated commands.

## Setup

Run:

```powershell
git config --global alias.new-from-dev "!f() { git fetch origin && git switch -c \"$1\" origin/dev; }; f"
git config --global alias.sync-dev-main "!git fetch origin && git switch dev && git merge --ff-only origin/main && git push origin dev"
git config --global alias.aheadbehind "!git fetch origin && git rev-list --left-right --count origin/main...origin/dev"
```

## Usage

Create a new feature/fix branch from latest `origin/dev`:

```powershell
git new-from-dev fix/short-description
```

Then set upstream on first push:

```powershell
git push -u origin fix/short-description
```

Sync `dev` to `main` after a release merge:

```powershell
git sync-dev-main
```

Check if `main` and `dev` are aligned:

```powershell
git aheadbehind
```

Expected aligned output:

```text
0    0
```

