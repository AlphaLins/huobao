# Huobao public access with ngrok

This document describes the first public-sharing MVP:

- Run Huobao on this computer.
- Expose one local production server through ngrok.
- Let invited users open a public HTTPS URL in their browser.

This phase does not add account isolation yet. Do not share the URL outside
trusted testers until authentication and per-user project ownership are added.

## 1. Prepare ngrok

1. Create or log into an ngrok account.
2. Install the ngrok agent.
3. Add your auth token:

```powershell
ngrok config add-authtoken <your-token>
```

4. In the ngrok dashboard, find your free assigned dev domain. On the free
   plan this domain is assigned by ngrok and cannot be customized.

ngrok starts an HTTPS endpoint with your assigned dev domain:

```powershell
ngrok http 5679
```

If your ngrok account supports explicitly selected domains, you can pass the URL:

```powershell
ngrok http http://localhost:5679 --url https://your-domain.ngrok-free.app
```

## 2. Build Huobao for single-port public serving

The easiest launcher is:

```powershell
.\start-public.bat
```

It builds the frontend, starts the production server, and opens an ngrok window.

For local-only development, use:

```powershell
.\start-local.bat
```

If you want custom login values, copy `start-public-custom.example.bat` to
`start-public-custom.bat`, edit the values, then run the copied file.

Manual commands are below.

From the project root:

```powershell
.\scripts\build-public.ps1
```

If dependencies need to be reinstalled:

```powershell
.\scripts\build-public.ps1 -Install
```

The script:

- runs backend typecheck
- generates the frontend static build
- copies `frontend/.output/public` to `frontend/dist`

The backend serves:

- `/`
- `/api/v1/*`
- `/static/*`

## 3. Start the local production server

In terminal 1:

```powershell
.\scripts\start-public.ps1 -PublicUrl "https://your-domain.ngrok-free.app"
```

For the first run, it is also valid to omit `-PublicUrl` because the frontend
and API are served from the same ngrok origin:

```powershell
.\scripts\start-public.ps1
```

Default login values for the MVP are:

```text
access password: huobao
admin username: admin
admin password: admin123
```

For public sharing, use custom values:

```powershell
.\scripts\start-public.ps1 -PublicAccessPassword "change-this" -AdminUsername "admin" -AdminPassword "change-this-too"
```

The server listens on:

```text
http://127.0.0.1:5679
```

## 4. Start ngrok

In terminal 2:

```powershell
.\scripts\start-ngrok.ps1
```

If your ngrok account supports explicitly selected domains:

```powershell
.\scripts\start-ngrok.ps1 -Url "https://your-domain.ngrok-free.app"
```

Copy the ngrok HTTPS URL from the terminal. That is the URL to send to testers.

## 5. Verify from outside the local network

Use a phone on mobile data, not the same Wi-Fi:

```text
https://your-domain.ngrok-free.app/api/v1/health
```

Expected response:

```json
{"status":"ok","timestamp":"..."}
```

Then open:

```text
https://your-domain.ngrok-free.app/
```

## 6. Known MVP limitations

- There is no login yet.
- All users can see and operate the same data.
- Users can consume the configured AI provider quota.
- ngrok free plans may show an interstitial browser warning page before the app.
- Do not expose this URL broadly until authentication is implemented.

Next implementation phase:

1. Global access password.
2. Multiple local accounts.
3. `dramas.user_id` ownership.
4. Permission checks on generation, upload, export, and AI settings.
