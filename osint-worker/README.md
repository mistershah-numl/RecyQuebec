# OSINT worker (Windows + VS Code)

No Kali required — this is pure Python (Playwright + httpx + BeautifulSoup + dnspython).

## 1. Setup (PowerShell in VS Code)

Use **Python 3.12** (3.14 has no prebuilt wheels for these packages and pip will try to
compile Rust/C++ from source, which fails without Visual C++ Build Tools).

```powershell
cd osint-worker
Remove-Item -Recurse -Force .venv   # if it was created with 3.14
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m playwright install chromium
```

If activation is blocked:
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`

## 2. Run

```powershell
$env:WORKER_SECRET="shah"
$env:HEADLESS="1"        # set to "0" once if a site needs a manual captcha click
$env:MAX_BROWSER_PAGES="3"
$env:RENDER_TIMEOUT_SECONDS="30"
$env:OSINT_TIMEOUT_SECONDS="90"
uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
```

Check: http://localhost:8000/health

Use exactly one Uvicorn process: Playwright already handles several pages concurrently. Multiple
Uvicorn workers would start multiple Chromium instances and waste memory. The health response shows
`active`, `queued`, `completed`, `failed`, and whether the browser is connected.

## 3. Expose with ngrok (second terminal)

```powershell
ngrok config add-authtoken <YOUR_TOKEN>
ngrok http 8000
```

Copy the `https://xxxx.ngrok-free.dev` URL.

## 4. Connect the app

App → **API Settings → OSINT render worker**:
- Worker URL: the ngrok https URL
- Worker secret: `shah` (same as WORKER_SECRET)
- Click **Test connection** → should say OK.

The ngrok URL changes each restart — repaste it when you restart ngrok.

For production, install the same folder on a Windows or Linux VPS, run the command above as a
managed service, expose port 8000 through HTTPS, and paste that stable HTTPS URL in API Settings.
The website host can be Lovable, Hostinger, or another provider; it only needs outbound HTTPS access
to the worker. Do not use `localhost` in the website settings.

If a request is stuck, open `/health`. Increasing `failed` means sites are timing out safely; it does
not stop the queue. Stop with Ctrl+C and restart Uvicorn if `browser_connected` is false. Queued rows
in the app are reclaimed and retried automatically.

## Endpoints
- `GET /health`
- `POST /render` `{ "url": "...", "wait_ms": 1200 }` — browser-rendered HTML/text, waits out Cloudflare
- `POST /osint` `{ "company": "...", "neq": "...", "city": "...", "extra_sites": ["yellowpages.ca"] }` — full company OSINT: website, emails (MX-checked), phones, address, LinkedIn/Facebook/b2bhint/OpenCorporates links, step log

Both protected by header `x-worker-secret`.
