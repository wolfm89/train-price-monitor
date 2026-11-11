# Data protection notes for this codebase

The public statements are the [privacy policy](https://wolfgangmoser.eu/privacy-policy/) and the
[legal notice](https://wolfgangmoser.eu/legal-notice/) (source: `wolfm89/landing-page`,
`privacy-policy/index.html`; German and English, the German version prevails). This page lists only
what a change in this repository has to respect, so that the policy stays true.

## What the app stores

| Where                                     | What                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cognito (eu-central-1)                    | email, first and last name, random user id, `sub`, password verifier, status, timestamps                                                                                                                                                         |
| DynamoDB `TrainPriceMonitor`, `USER#<id>` | `METADATA#`: email, names, `cognitoSub`, notification switch, travel preferences, picture key; `JOURNEY#<id>`: search details, limit price, expiry, DB refresh token, last price; `NOTIFICATION#<id>`: type, time, read/sent flags, journey data |
| S3                                        | profile picture `<user id>.<ext>`, KMS-encrypted, not versioned                                                                                                                                                                                  |
| SES (sandbox only)                        | the user's address as a recipient identity; the account-level suppression list holds addresses that bounced or complained                                                                                                                        |
| SQS                                       | user id and notification id in the email job                                                                                                                                                                                                     |
| CloudWatch, CloudTrail                    | pseudonymous ids, counts and redacted error messages; CloudTrail's event history records sign-up/sign-in calls, including the caller's IP address                                                                                                |
| Browser                                   | landing page `theme`, blog `pref-theme`, app `CognitoIdentityServiceProvider.*` (60 min tokens, 30-day refresh token). No cookies anywhere                                                                                                       |

## Rules for changes

1. **No personal data in logs**: no email addresses, names, free-text search input, raw events,
   request bodies or tokens. Log pseudonymous ids and counts; pass AWS error messages through
   `redactEmails` (`backend/src/lib/redact.ts`); never log a GraphQL error that quotes client input
   (`graphqlErrorLogEntry`).
2. **Every per-user item must be covered** by `exportMyData` (`backend/src/resolvers/user.ts`),
   `deleteUser` and the TTL rules in `backend/src/lib/retention.ts`. A new item type gets a `ttl` or
   a documented reason why not, and both queries must read every page (`maxPages: Infinity`).
3. **CORS is an allowlist** (`CORS_ALLOWED_ORIGINS`, the API Gateway preflight and the 401 gateway
   response). Do not reintroduce `*` or the credentials flag.
4. **Uploads are validated by content** (`backend/src/lib/profilePicture.ts`), never by the client's
   file name or MIME type.
5. **No third-party requests**: fonts are self-hosted on all three sites, and there is no analytics,
   tracking or embedded third-party script. A new one changes the policy before it ships.
6. **New browser storage** needs a § 25 TDDDG justification, an entry in the policy's storage list,
   and a way to remove it when the user signs out or clears it.

Any change to what is stored, logged, sent to a third party or kept in the browser is released
together with an update to the policy (both languages and the "Stand / Last updated" date) in
`wolfm89/landing-page`.

## Retention

| Data                             | Deleted                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| Account, profile picture         | with the account; database backups (PITR) keep it up to 35 more days                       |
| Unconfirmed sign-ups             | 7 days, by the daily `deleteUnconfirmedSignups` job                                        |
| Watched journeys                 | by the hourly refresher at expiry (departure − 1 h), otherwise TTL 7 days after expiry     |
| Notifications                    | TTL 90 days, but no earlier than 7 days after the related journey; price alerts go with it |
| Email job messages               | SQS 4 days, dead-letter queue 14 days                                                      |
| Lambda, API Gateway logs         | 14 days (CDK-managed)                                                                      |
| CloudTrail event history         | 90 days (AWS-managed)                                                                      |
| Mail to `legal@wolfgangmoser.eu` | once the matter is closed, unless needed for legal claims                                  |

## Sending email

- Sender: `trainpricemonitor@wolfgangmoser.eu`. The domain identity `wolfgangmoser.eu` is created by
  the stack with Easy DKIM; the `SesDkimToken*` outputs are the CNAME records for the DNS provider.
  Do not create that identity by hand as well, and do not change the sender domain casually: either
  replaces the identity and its tokens.
- **Sandbox:** SES delivers only to verified addresses, so `createUser` registers each user's
  address as a recipient identity and `deleteUser` removes it. Set the repository variable
  `CDK_SES_PRODUCTION_ACCESS=1` once AWS grants production access; the Lambdas then get
  `SES_SANDBOX=false` and lose the identity permissions, and the remaining per-user identities are
  deleted by hand.
- `deleteUser` also removes the address from the SES account-level suppression list.

## Scripts

- `scripts/backfill-ttl.mjs` gives journeys and notifications created before the TTL existed their
  deletion date. Run it after a deploy that introduces a `ttl` field (it only fills gaps).
- `scripts/cleanup-ses-identities.mjs` deletes SES identities of accounts that no longer exist.
- `scripts/backfill-cognito-sub.mjs` binds existing rows to their Cognito identity (one-off).
