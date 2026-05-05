---
name: local-e2e-testing
description: Start backend and frontend dev servers locally, then test the Train Price Monitor website end-to-end using Playwright MCP. Covers server startup, GraphQL schema verification, authenticated UI flows, network request inspection, and cleanup.
---

## What I do

Walk through the full local E2E test workflow:

1. Ensure Playwright browser is available
2. Start backend and frontend dev servers in the background
3. Verify both servers are up via health checks
4. Optionally verify the GraphQL schema via introspection
5. Use Playwright MCP to drive the browser (login, search, watchlist, notifications)
6. Inspect network requests to confirm GraphQL query/mutation shapes
7. Kill all dev servers when done

---

## Step 1 — Install Playwright browser (once)

```bash
npx @playwright/mcp install-browser chrome-for-testing
```

Only needed on first use or after a Playwright version bump. Safe to run again — it's a no-op if already installed.

---

## Step 2 — Start dev servers

Run both in the background, capturing logs:

```bash
# Terminal / background — backend (sets LOCAL_DEV=1 automatically via mise task)
cd /path/to/project && mise run //backend:dev > /tmp/backend.log 2>&1 &
echo "Backend PID: $!"

# Terminal / background — frontend
cd /path/to/project && mise run //frontend:dev > /tmp/frontend.log 2>&1 &
echo "Frontend PID: $!"
```

**Ports:**

- Backend: `http://localhost:4000` (GraphQL at `/graphql`, health at `/health`)
- Frontend: `http://localhost:3000`

Wait ~8–10 seconds for both to finish cold-starting before running checks.

---

## Step 3 — Health checks

```bash
sleep 8
curl -s http://localhost:4000/health          # expect {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/  # expect 200
```

If the backend fails to start, check `/tmp/backend.log`. Common cause: missing env vars (`TPM_SQS_QUEUE_URL`, `PROFILE_IMAGE_BUCKET_NAME`) — these are set in `backend/.env`.

If the frontend gives a non-200, check `/tmp/frontend.log` for Vite errors.

---

## Step 4 — Optional: verify GraphQL schema via introspection

Use this to confirm schema changes are live without needing a browser login. The backend does **not** require auth for introspection in local dev.

```bash
# Check all type names
curl -s -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ __schema { types { name } } }"}' \
  | python3 -c "import json,sys; [print(t['name']) for t in json.load(sys.stdin)['data']['__schema']['types'] if not t['name'].startswith('__')]"

# Inspect a specific type's fields
curl -s -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ __type(name: \"Journey\") { fields { name type { name kind ofType { name } } } } }"}' \
  | python3 -m json.tool

# Inspect mutation args (e.g. verify monitorJourney has no unwanted fields)
curl -s -X POST http://localhost:4000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ __type(name: \"Mutation\") { fields { name args { name } } } }"}' \
  | python3 -m json.tool
```

---

## Step 5 — Playwright MCP browser testing

### Navigate and take initial snapshot

```
playwright_browser_navigate { url: "http://localhost:3000" }
playwright_browser_snapshot {}
playwright_browser_console_messages { level: "warning" }  # check for errors
```

### Log in

The app uses real Cognito. Test credentials are stored in the root `.env` file as `TEST_USER_EMAIL` and `TEST_USER_PASSWORD`. Read them before starting the test session:

```bash
source .env
echo "Using test user: $TEST_USER_EMAIL"
```

The login dialog is triggered by clicking the Login button on the home page. Credentials are read
from `process.env` — they are injected at startup via the root `.env` file (see above):

```
playwright_browser_run_code_unsafe {
  code: `async (page) => {
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForTimeout(500);
    await page.getByRole('textbox', { name: 'Email' }).fill(process.env.TEST_USER_EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill(process.env.TEST_USER_PASSWORD);
    await page.getByRole('button', { name: 'Login' }).click();
    await page.waitForTimeout(3000);
  }`
}
playwright_browser_take_screenshot { filename: "after-login.png", type: "png" }
```

After login, the header shows Search / Journey Watchlist / notification bell / profile picture. If it still shows Sign up / Login, check for auth errors in the console.

### Search for journeys

```
playwright_browser_run_code_unsafe {
  code: `async (page) => {
    await page.getByRole('link', { name: 'Search' }).click();
    await page.waitForTimeout(500);
    const inputs = page.locator('input[role="combobox"]');
    await inputs.first().fill('München');
    await page.waitForTimeout(1500);
    await page.getByRole('option', { name: 'München Hbf' }).first().click();
    await inputs.nth(1).fill('Berlin');
    await page.waitForTimeout(1500);
    await page.getByRole('option', { name: 'Berlin Hbf' }).first().click();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    await page.locator('input[type="date"]').fill(tomorrow.toISOString().split('T')[0]);
    await page.locator('input[type="time"]').fill('10:00');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(8000);
  }`
}
playwright_browser_take_screenshot { filename: "search-results.png", type: "png" }
```

Results should show a table with Departure Time / Arrival Time / Duration / Means of Transport / Price / WATCH buttons.

### Add a journey to the watchlist

The WATCH buttons are **inside a `<table>`**. Do NOT use `button:has-text("Watch")` — that also matches the "Journey Watchlist" nav button. Use:

```
playwright_browser_run_code_unsafe {
  code: `async (page) => {
    await page.locator('table button').first().click();
    await page.waitForTimeout(500);
  }`
}
```

A "Set Limit Price" dialog opens showing the current price. Enter a limit price **above** the current price:

```
playwright_browser_run_code_unsafe {
  code: `async (page) => {
    await page.getByRole('spinbutton', { name: 'Limit Price' }).fill('200');
    await page.getByRole('button', { name: 'Confirm' }).click();
    await page.waitForTimeout(4000);
  }`
}
```

### Inspect the GraphQL mutation in network requests

After clicking Confirm, use `playwright_browser_network_requests` to find the POST to `/graphql` and verify its body:

```
playwright_browser_network_requests { filter: "/graphql", static: false }
# Note the index of the POST request, then:
playwright_browser_network_request { index: <N>, part: "request-body" }
playwright_browser_network_request { index: <N>, part: "response-body" }
```

The mutation body should contain `fromId`/`toId` (not `from`/`to`). The response should contain a `JourneyMonitor` with an `id`.

### Verify the Journey Watchlist

```
playwright_browser_run_code_unsafe {
  code: `async (page) => {
    await page.getByRole('link', { name: 'Journey Watchlist' }).click();
    await page.waitForTimeout(3000);
  }`
}
playwright_browser_take_screenshot { filename: "watchlist.png", type: "png" }
```

The accordion header should show human-readable station names (e.g. "München Hbf to Berlin Hbf"), a limit price, and a current price. Expand the accordion to verify departure / arrival / means of transport.

### Check notifications panel

Click the bell icon in the header to open the notifications popover. With a fresh account this will be empty, but the panel should open without errors.

### Clean up test data

Delete any journey monitors added during testing:

```
playwright_browser_run_code_unsafe {
  code: `async (page) => {
    await page.locator('button[aria-label="delete"]').click();
    await page.waitForTimeout(1000);
  }`
}
```

---

## Step 6 — Console error check

At any point, check for unexpected JS errors:

```
playwright_browser_console_messages { level: "error" }
```

Known pre-existing non-critical warning (not introduced by us):

> "Encountered two children with the same key `Berlin Hbf`" — duplicate React key in the station autocomplete component.

Any other errors should be investigated.

---

## Step 7 — Kill dev servers

```bash
# Kill by finding the processes
pkill -9 -f "ts-node-dev" 2>/dev/null
pkill -9 -f "vite" 2>/dev/null

# Or kill by PID if you saved them
kill -9 <BACKEND_PID> <FRONTEND_PID>

# Verify ports are free
ss -tlnp | grep -E ':3000|:4000' || echo "ports clear"
```

---

## Environment requirements

- `backend/.env` must exist with `TPM_SQS_QUEUE_URL`, `PROFILE_IMAGE_BUCKET_NAME`, `AWS_PROFILE`
- `frontend/.env` must exist with Cognito pool IDs and `REACT_APP_AWS_REGION`
- `frontend/.env.development` must set `REACT_APP_GRAPHQL_ENDPOINT=http://localhost:4000/`
- AWS credentials must be valid for the profile in `backend/.env` (DynamoDB reads/writes happen against live AWS)
- Root `.env` contains `TEST_USER_EMAIL` and `TEST_USER_PASSWORD` — real Cognito credentials for the test account; `source .env` before starting

---

## Known gotchas

- **`button:has-text("Watch")` matches the nav button too** — always use `table button` or `button[type="submit"]` to target table-row buttons
- **`getByLabel` can match a dialog container and its input** — use `getByRole('spinbutton', { name: '...' })` for number inputs
- **Backend logs no incoming requests by default** — use `playwright_browser_network_requests` to verify GraphQL traffic instead
- **Cold start after deploy** — the first Lambda invocation post-deploy takes ~15s; not relevant for local testing but worth noting
- **`mise run //frontend:dev` navigating directly to `/search` redirects to `/`** — always use the nav link after login, not `playwright_browser_navigate` to a protected route
