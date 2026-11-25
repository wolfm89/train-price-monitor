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

## Step 1 — Ensure Playwright browser is available

Check if a Playwright browser is already installed (e.g. from a previous run):

```bash
ls ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null && echo "already installed" || echo "needs install"
```

If not installed (or after a Playwright version bump):

```bash
npx @playwright/mcp install-browser chrome-for-testing
```

---

## Step 2 — Start dev servers (if not already running)

Check if each server is already running before starting:

```bash
# Backend — only start if not listening on :4000
ss -tlnp | grep -q ':4000' && echo "backend already running" || {
  mise run //backend:dev &
  echo "Backend PID: $!"
}

# Frontend — only start if not listening on :3000
ss -tlnp | grep -q ':3000' && echo "frontend already running" || {
  mise run //frontend:dev &
  echo "Frontend PID: $!"
}
```

The mise tasks now pipe output through `tee` — stdout appears in your terminal AND is logged to `/tmp/{module}.log`. No need to redirect manually. The servers watch for file changes, so there is no need to kill and restart them if they are already running.

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

The Search button is not `type="submit"` — use `getByRole('button', { name: 'Search', exact: true })` instead.

The transport modes chips now merge RE and RB into a single **"RE/RB"** toggle — the db-vendo-client vendo API classifies all regional trains under the `REGIONAL` product key. There are now 9 product toggles (down from 10).

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
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.waitForTimeout(8000);
  }`
}
playwright_browser_take_screenshot { filename: "search-results.png", type: "png" }
```

Results should show one card per connection with departure/arrival time, duration, means of transport, price and a **+ Watch** action.

### Add a journey to the watchlist

Search results are cards, not a table. Target the row action by its accessible name; every row has a contextual “Add the … connection to your watchlist” label:

```
playwright_browser_run_code_unsafe {
  code: `async (page) => {
    await page.getByRole('button', { name: /Add the .* connection to your watchlist/ }).first().click();
    await page.waitForTimeout(500);
  }`
}
```

A "Set limit price" dialog opens showing the current price. Enter a limit price **above** the current price:

```
playwright_browser_run_code_unsafe {
  code: `async (page) => {
    await page.getByRole('textbox', { name: 'Limit price' }).fill('200');
    await page.getByRole('button', { name: 'Save limit' }).click();
    await page.waitForTimeout(4000);
  }`
}
```

### Inspect the GraphQL mutation in network requests

After clicking Save limit, use `playwright_browser_network_requests` to find the POST to `/graphql` and verify its body:

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
    await page.getByRole('link', { name: 'My Journeys' }).click();
    await page.waitForTimeout(3000);
  }`
}
playwright_browser_take_screenshot { filename: "watchlist.png", type: "png" }
```

The ticket card shows the station names, limit/current price, departure/arrival and means of transport. There is no accordion.

### Check notifications panel

Click the bell icon in the header to open the notifications popover. With a fresh account this will be empty, but the panel should open without errors.

### Clean up test data

Delete any journey monitors added during testing with the ticket's kebab menu:

```
playwright_browser_run_code_unsafe {
  code: `async (page) => {
    await page.getByRole('button', { name: 'more options' }).first().click();
    await page.getByText('Remove from watchlist').click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
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

## Step 7 — Kill dev servers (if running in this session)

If you started the servers in this session and they need to be cleaned up:

```bash
# Kill by finding the processes
pkill -9 -f "backend/scripts/dev.mjs" 2>/dev/null
pkill -9 -f "vite" 2>/dev/null

# Or kill by PID if you saved them
kill -9 <BACKEND_PID> <FRONTEND_PID>

# Verify ports are free
ss -tlnp | grep -E ':3000|:4000' || echo "ports clear"
```

If the servers were already running before this session (checked in Step 2), leave them running — they continue to watch for changes.

---

## Environment requirements

- `backend/.env` must exist with `TPM_SQS_QUEUE_URL`, `PROFILE_IMAGE_BUCKET_NAME`, `AWS_PROFILE` (`mise run env:local`)
- `frontend/.env` must exist with Cognito pool IDs and `REACT_APP_AWS_REGION`
- the dev server proxies `/graphql` to `VITE_DEV_BACKEND_URL` (default `http://127.0.0.1:4000`); no `.env.development` is needed
- AWS credentials must be valid for the profile in `backend/.env` (DynamoDB reads/writes happen against live AWS)
- Root `.env` contains `TEST_USER_EMAIL` and `TEST_USER_PASSWORD` — real Cognito credentials for the test account; `source .env` before starting

---

## Known gotchas

- **Search results are cards, not a table** — target a row action by its contextual accessible name (`/Add the .* connection to your watchlist/`), not by the shared visible `+ Watch` text.
- **The limit-price input is a textbox with decimal inputmode** — use `getByRole('textbox', { name: 'Limit price' })`, not `spinbutton`.
- **Backend logs no incoming requests by default** — use `playwright_browser_network_requests` to verify GraphQL traffic instead
- **Cold start after deploy** — the first Lambda invocation post-deploy takes ~15s; not relevant for local testing but worth noting
- **`mise run //frontend:dev` navigating directly to `/search` redirects to `/`** — always use the nav link after login, not `playwright_browser_navigate` to a protected route
