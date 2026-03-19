# Google Workspace Setup

## Prerequisites

1. **gws CLI** (v0.18.1+) — the Google Workspace CLI tool
2. **Google Cloud project** with OAuth consent screen configured
3. **OAuth2 credentials** for each Google account you want to use

## Install gws CLI

```bash
npm install -g @googleworkspace/cli
gws --version  # should show 0.18.1+
```

## Authentication

### How credentials work

- `gws auth login` stores encrypted credentials in `~/.config/gws/` (override with `GOOGLE_WORKSPACE_CLI_CONFIG_DIR`)
- `gws auth export --unmasked` exports them as a plaintext JSON file (the format Raven needs)
- At runtime, `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` tells gws which credential file to use

### Setup (two accounts sharing one GCP project)

Both accounts must be added as **test users** in your GCP OAuth consent screen
(Google Cloud Console → APIs & Services → OAuth consent screen → Test users).

```bash
# 1. Login as personal account
gws auth login
# Sign in with your personal Google account in the browser
gws auth export --unmasked > data/gws-credentials-personal.json

# 2. Login as student account (overwrites default config — that's fine)
gws auth login
# Sign in with your student Google account in the browser
gws auth export --unmasked > data/gws-credentials-student.json

# 3. Verify both work
GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=./data/gws-credentials-personal.json gws gmail +triage
GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=./data/gws-credentials-student.json gws gmail +triage
```

### Environment variables

Set in `.env`:
```bash
GWS_PRIMARY_CREDENTIALS_FILE=./data/gws-credentials-personal.json
GWS_SECONDARY_CREDENTIALS_FILE=./data/gws-credentials-student.json
GWS_GCP_PROJECT_ID=your-gcp-project-id
```

## Multi-Account Support

The gws-agent supports two simultaneous accounts via credential file switching:
- **Primary**: Default account for Gmail, Calendar, Drive, Tasks, Docs, People (uses `GWS_PRIMARY_CREDENTIALS_FILE`)
- **Secondary**: Second account with access to the same APIs (uses `GWS_SECONDARY_CREDENTIALS_FILE`)

To use the secondary account, prefix any gws command with the credentials env var:
```bash
GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=$GWS_SECONDARY_CREDENTIALS_FILE gws gmail +triage
```

## Gmail Pub/Sub (Email Watching)

The email watcher uses `gws gmail +watch` which requires a GCP Pub/Sub topic.

### Setup

1. Create a GCP project (or use existing)
2. Enable Gmail API and Pub/Sub API
3. Create a Pub/Sub topic: `projects/<PROJECT_ID>/topics/gmail-push`
4. Grant Gmail push permissions to the topic
5. Set the env var:

```bash
GWS_GCP_PROJECT_ID=your-gcp-project-id
```

The watcher auto-reconnects if the process exits (30-second delay).

## Credential file locations

| File | Purpose |
|------|---------|
| `~/.config/gws/client_secret.json` | OAuth client config (from GCP console download) |
| `~/.config/gws/credentials.enc` | Encrypted credentials (written by `gws auth login`) |
| `~/.config/gws/.encryption_key` | Encryption key (keyring fallback on WSL2) |
| `~/.config/gws/token_cache.json` | Cached access token (auto-refreshed) |
| `data/gws-credentials-*.json` | Exported plaintext credentials for Raven services |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GWS_PRIMARY_CREDENTIALS_FILE` | Yes | Path to primary gws credentials JSON |
| `GWS_SECONDARY_CREDENTIALS_FILE` | No | Path to secondary account credentials JSON |
| `GWS_GCP_PROJECT_ID` | No* | GCP project ID for Gmail Pub/Sub watch |

*Required only if email watching is desired.

## Verification

```bash
# Check auth status
gws auth status

# Test a command
gws calendar +agenda --today --format json

# Test with specific credentials
GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=./data/gws-credentials-personal.json gws calendar +agenda --today --format json
```

## Skill Reference Docs

Download skill reference documentation for the agent:

```bash
npm run update:gws
```

This fetches SKILL.md files from the gws CLI GitHub repo into `suites/google-workspace/skills-reference/`.

## Troubleshooting

### "gws: command not found"
Install globally: `npm install -g @googleworkspace/cli`

### Auth token expired / "Failed to get token"
Re-authenticate and re-export:
```bash
gws auth login
gws auth export --unmasked > data/gws-credentials-personal.json
```

### Email watcher not starting
1. Check logs: `grep -i 'email-watcher\|gws' data/logs/raven.1.log`
2. Verify both `GWS_PRIMARY_CREDENTIALS_FILE` and `GWS_GCP_PROJECT_ID` are set
3. Test credentials: `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=$GWS_PRIMARY_CREDENTIALS_FILE gws gmail +triage`

### Secondary account tools not working
Ensure `GWS_SECONDARY_CREDENTIALS_FILE` is set and the account is a test user in the GCP OAuth consent screen.
