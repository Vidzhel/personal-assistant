# Google Workspace Setup

## Prerequisites

1. **gws CLI** (v0.18.1+) — the Google Workspace CLI tool
2. **Google Cloud project** with Gmail Pub/Sub enabled (for email watching)
3. **OAuth2 credentials** for at least one Google account

## Install gws CLI

```bash
npm install -g @googleworkspace/cli
gws --version  # should show 0.18.1+
```

## Authentication

### Primary Account

```bash
gws auth login
```

This creates a credentials file (check `gws auth status` for the path).

Set the env var:
```bash
GWS_PRIMARY_CREDENTIALS_FILE=/path/to/credentials.json
```

### Meet Account (Optional)

If you use a separate account for Google Meet:

```bash
GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/meet-creds.json gws auth login
```

Set the env var:
```bash
GWS_MEET_CREDENTIALS_FILE=/path/to/meet-creds.json
```

## Multi-Account Support

The gws-agent supports two simultaneous accounts via credential file switching:
- **Primary**: Default account for Gmail, Calendar, Drive, Tasks, Docs, People (uses `GWS_PRIMARY_CREDENTIALS_FILE`)
- **Meet**: Separate account for Meet recordings, transcripts, and smart notes (uses `GWS_MEET_CREDENTIALS_FILE`)

To use the meet account, prefix any gws command with the credentials env var:
```bash
GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=$GWS_MEET_CREDENTIALS_FILE gws meet ...
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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GWS_PRIMARY_CREDENTIALS_FILE` | Yes | Path to primary gws credentials JSON |
| `GWS_MEET_CREDENTIALS_FILE` | No | Path to Meet account credentials JSON |
| `GWS_GCP_PROJECT_ID` | No* | GCP project ID for Gmail Pub/Sub watch |

*Required only if email watching is desired.

## Verification

```bash
# Check auth status
gws auth status

# Test a command
gws calendar +agenda --today --format json

# Test with specific credentials
GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/creds.json gws calendar +agenda --today --format json
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

### Auth token expired
Re-authenticate: `gws auth login`

### Email watcher not starting
Check that both `GWS_PRIMARY_CREDENTIALS_FILE` and `GWS_GCP_PROJECT_ID` are set.

### Meet tools not working
Ensure `GWS_MEET_CREDENTIALS_FILE` is set and the account has access to Meet recordings.
