# Google OAuth2 Setup for Gmail

This guide walks you through setting up Google OAuth2 credentials so Raven can read and manage your Gmail.

## What You're Setting Up

Raven needs two things for Gmail:

1. **IMAP App Password** - For real-time email monitoring (IMAP IDLE)
2. **OAuth2 Credentials** - For the Gmail MCP server used by sub-agents (read, search, send, label)

## Part 1: Gmail App Password (for IMAP monitoring)

This is the simpler setup. It gives Raven access to monitor your inbox via IMAP.

1. Go to https://myaccount.google.com/security
2. Make sure **2-Step Verification** is enabled (required for app passwords)
3. Go to https://myaccount.google.com/apppasswords
4. Select app: "Mail", device: "Other (Custom name)" → enter "Raven"
5. Click **Generate**
6. Copy the 16-character password (format: `xxxx xxxx xxxx xxxx`)

Add to `.env`:
```
GMAIL_IMAP_USER=you@gmail.com
GMAIL_IMAP_PASSWORD=xxxx xxxx xxxx xxxx
```

## Part 2: OAuth2 Credentials (for Gmail MCP)

This is more involved but gives Raven full Gmail API access through the MCP server.

### Step 1: Create a Google Cloud Project

1. Go to https://console.cloud.google.com/
2. Click the project dropdown at the top → **New Project**
3. Name it `raven-assistant` (or anything you like)
4. Click **Create**
5. Select the new project from the dropdown

### Step 2: Enable the Gmail API

1. Go to **APIs & Services** → **Library** (or https://console.cloud.google.com/apis/library)
2. Search for **Gmail API**
3. Click on it → Click **Enable**

### Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. Select **External** user type → Click **Create**
3. Fill in:
   - App name: `Raven`
   - User support email: your email
   - Developer contact email: your email
4. Click **Save and Continue**
5. **Scopes** page: Click **Add or Remove Scopes**
   - Search for and add these scopes:
     - `https://www.googleapis.com/auth/gmail.readonly` (Read all email)
     - `https://www.googleapis.com/auth/gmail.send` (Send email)
     - `https://www.googleapis.com/auth/gmail.modify` (Modify: labels, mark read)
     - `https://www.googleapis.com/auth/gmail.labels` (Manage labels)
   - Click **Update** → **Save and Continue**
6. **Test users** page: Click **Add Users**
   - Add your own Gmail address
   - Click **Save and Continue**
7. Click **Back to Dashboard**

> **Note**: The app stays in "Testing" mode which is fine — it only needs to work for you. No need to publish or verify.

### Step 4: Create OAuth2 Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **+ Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `Raven`
5. Under **Authorized redirect URIs**: click **+ Add URI**
   - Add: `http://localhost:8080/callback`
6. Click **Create**
7. A dialog shows your **Client ID** and **Client Secret** — copy both

### Step 5: Generate Refresh Token

Run the token generation script:

```bash
node scripts/google-oauth.mjs YOUR_CLIENT_ID YOUR_CLIENT_SECRET
```

This will:
1. Open your browser to Google's consent page
2. You sign in and authorize Raven
3. Google redirects back to `localhost:8080/callback`
4. The script exchanges the code for a **refresh token**
5. The token is printed in your terminal

Add to `.env`:
```
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=GOCSPX-...
GMAIL_REFRESH_TOKEN=1//0e...
```

### Troubleshooting

**"No refresh_token returned"**
- Go to https://myaccount.google.com/connections
- Find "Raven" and click **Remove Access**
- Run the script again — you need `prompt=consent` (the script includes this) to get a refresh token

**"Access blocked: This app's request is invalid" (Error 400)**
- Make sure `http://localhost:8080/callback` is in your **Authorized redirect URIs** (exact match, no trailing slash)

**"This app isn't verified"**
- Click **Advanced** → **Go to Raven (unsafe)** — this is expected for testing mode apps that only you use

## Summary of Scopes

| Scope | What it allows |
|-------|---------------|
| `gmail.readonly` | Read emails, threads, labels, message content |
| `gmail.send` | Send emails on your behalf |
| `gmail.modify` | Mark read/unread, add/remove labels, archive |
| `gmail.labels` | Create and manage custom labels |

These are the minimum scopes needed for the Gmail MCP to be useful. Raven never deletes emails — `gmail.modify` only allows label changes and read state.
