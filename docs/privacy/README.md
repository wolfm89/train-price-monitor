# Privacy documentation

Internal records for the hosted Train Price Monitor at <https://tpm.wolfgangmoser.eu>, operated by
Wolfgang Moser as a private, non-commercial project. The public texts live elsewhere:

- Privacy policy: <https://wolfgangmoser.eu/privacy-policy/> (source: `wolfm89/landing-page`,
  `privacy-policy/index.html`; German and English, the German version prevails)
- Legal notice: <https://wolfgangmoser.eu/legal-notice/>
- Contact for data protection: `legal@wolfgangmoser.eu`

| Document                                             | Purpose                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| [records-of-processing.md](records-of-processing.md) | Record of processing activities (Art. 30 GDPR), retention, security measures |
| [processors.md](processors.md)                       | Processors and other recipients, transfers, contract status                  |
| [data-subject-requests.md](data-subject-requests.md) | How to handle access, erasure and other requests (Art. 12–22 GDPR)           |
| [email-and-ses.md](email-and-ses.md)                 | Leaving the SES sandbox, DKIM/DMARC, sending as `legal@`                     |

## Keeping the policy true

The privacy policy describes what the deployed code does. Before merging a change that alters what
is stored, logged, sent to a third party or kept in the browser:

1. Update the records in this folder.
2. Update both language versions of the privacy policy in the landing-page repo, including the
   "Stand / Last updated" date, and deploy it no later than the code change.
3. Check that `exportMyData` and `deleteUser` still cover every per-user item, and that new item
   types get a `ttl` (`backend/src/lib/retention.ts`).

## Open items

Known gaps, deliberately not implemented yet:

- **Names cannot be edited.** `given_name` and `family_name` are required and immutable attributes
  of the Cognito user pool, and Cognito cannot change that on an existing pool. Making them
  optional/editable needs a new user pool and a user migration. Until then, rectification requests
  are handled by deleting the account so that the user can register again (see
  [data-subject-requests.md](data-subject-requests.md)).
- **No deletion of inactive accounts.** Accounts are kept until the user deletes them. An automatic
  clean-up would need last-activity tracking, a reminder email and server-side `AdminDeleteUser`.
- **Login removal is client-side.** Account deletion deletes the app data through the API and then
  the Cognito user from the browser. If the second step fails, the login has to be removed by hand
  (the app asks the user to write to `legal@`). A server-side `AdminDeleteUser` would remove that
  gap.
- **No Content-Security-Policy** on the frontend yet. Fonts are now self-hosted, so a strict CSP is
  possible; it needs testing against Cognito, the API and the S3 picture URLs.
- **Point-in-time recovery** keeps 35 days of table history, including deleted accounts. A shorter
  window (DynamoDB allows 1–35 days) would shorten that tail at the cost of recovery options.
- **Cognito sends its own emails** (sign-up confirmation, password reset) from
  `no-reply@verificationemail.com`. After the SES production access (see
  [email-and-ses.md](email-and-ses.md)) they can be sent through SES from the app's own address.
