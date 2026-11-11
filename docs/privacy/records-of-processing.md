# Record of processing activities

Art. 30(1) GDPR. Last reviewed: 11 November 2026.

**Controller:** Wolfgang Moser, Theresienhöhe 6B, 80339 München, Germany; `legal@wolfgangmoser.eu`.
Private individual, no employees, no data protection officer (not required, § 38 BDSG).
**Supervisory authority:** Bayerisches Landesamt für Datenschutzaufsicht (BayLDA), Promenade 18,
91522 Ansbach.

The landing page (`wolfgangmoser.eu`) and the blog (`blog.wolfgangmoser.eu`) are included because
they share the privacy policy. All three sites are private and non-commercial.

## Processing activities

### P1 — Hosting of the landing page and the blog (GitHub Pages)

| Field                  | Entry                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose                | Deliver the static sites; GitHub's own abuse and security protection                                                                                                                            |
| Legal basis            | Art. 6(1)(f): interest in reliable, secure and free hosting of a private website                                                                                                                |
| Data subjects          | Visitors                                                                                                                                                                                        |
| Data                   | IP address, requested URL, date/time, browser data in the HTTP request                                                                                                                          |
| Recipients             | GitHub B.V. / GitHub, Inc.; GitHub logs visitor IP addresses for security purposes under its own privacy statement                                                                              |
| Third-country transfer | USA (GitHub, Inc.): EU-U.S. Data Privacy Framework (adequacy decision (EU) 2023/1795); GitHub also uses SCCs (2021/914)                                                                         |
| Retention              | Set by GitHub; the controller has no access to these logs                                                                                                                                       |
| Notes                  | No cookies, analytics or third-party requests: fonts are self-hosted. `localStorage` keys `theme` (landing) and `pref-theme` (blog) keep the colour scheme on the device (§ 25(2) no. 2 TDDDG). |

### P2 — Train Price Monitor account

| Field                  | Entry                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Purpose                | Registration, login, password reset, account settings                                                                                                                                                                                                                                                                                                  |
| Legal basis            | Art. 6(1)(b) (use of the service on the user's request)                                                                                                                                                                                                                                                                                                |
| Data subjects          | Registered users                                                                                                                                                                                                                                                                                                                                       |
| Data                   | Cognito: email, first and last name, random user id (`custom:id`), Cognito `sub`, password verifier, verification status, timestamps. DynamoDB `USER#<id>/METADATA#`: the same email and names, `cognitoSub`, notification switch, travel preferences (discount cards, age group, Deutschlandticket), profile picture key, created/modified timestamps |
| Recipients             | AWS (processor, see [processors.md](processors.md))                                                                                                                                                                                                                                                                                                    |
| Third-country transfer | Data is stored in `eu-central-1`. AWS EMEA SARL may use sub-processors outside the EU under its DPA (SCCs 2021/914, DPF for US entities); CloudFront serves the static app from edge locations worldwide                                                                                                                                               |
| Retention              | Until the user deletes the account; then removed from Cognito, DynamoDB and S3 at once; table backups (PITR) keep it for up to 35 more days. Sign-ups not confirmed within 7 days are deleted from Cognito by the daily `deleteUnconfirmedSignups` job                                                                                                 |
| Browser storage        | `CognitoIdentityServiceProvider.*` in `localStorage`: ID/access tokens (60 min), refresh token (30 days), last user, clock drift (§ 25(2) no. 2 TDDDG)                                                                                                                                                                                                 |

Delivering the app's static files through CloudFront to visitors without an account (IP address
processed transiently, no CloudFront access logs) is based on Art. 6(1)(f): interest in secure
and reliable delivery of the app.

### P3 — Journey search and price monitoring

| Field                  | Entry                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose                | Find connections, store monitored journeys, re-check prices hourly                                                                                                                                                                                                                                                                                                                    |
| Legal basis            | Art. 6(1)(b)                                                                                                                                                                                                                                                                                                                                                                          |
| Data                   | Station search text (matched locally against a bundled station list, never sent to DB). Journey queries: station IDs, date/time, class, bike, age group, discount card, Deutschlandticket option. Monitored journeys (`JOURNEY#<id>`): the query, limit price, expiry, DB refresh token, last price snapshot                                                                          |
| Recipients             | DB Fernverkehr AG (bahn.de journey API, independent controller), receives the query parameters from AWS — not the user's IP address or any account data. If DB rejects the direct request, the same request goes through Decodo's Web Scraping API (processor).                                                                                                                       |
| Third-country transfer | Decodo routes requests through its global proxy network, so they may pass servers outside the EEA. Decodo's DPA (22 Apr 2025) contains no SCCs or transfer clause; the requests contain no account identifiers, so neither Decodo nor the proxy operators can link them to a person. Open item for the lawyer (pinning the Decodo exit to an EU country is the technical alternative) |
| Retention              | A journey is deleted by the hourly refresher once it expires (departure − 1 h), by the user, or with the account. As a fallback its DynamoDB TTL falls due 7 days after expiry; DynamoDB then deletes it asynchronously, usually within a few days                                                                                                                                    |

### P4 — Notifications and notification emails

| Field       | Entry                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose     | Tell users about price alerts, expired and untrackable journeys, in the app and (if switched on) by email                                                                                                                                                     |
| Legal basis | Art. 6(1)(b)                                                                                                                                                                                                                                                  |
| Data        | `NOTIFICATION#<id>`: type, time, read/sent flags, journey id, station names/ids, price and limit. Email: recipient address, first name, stations, prices, link to the journey                                                                                 |
| Recipients  | AWS (SQS carries user id + notification id; SES sends the email from `SES_FROM_EMAIL` = `trainpricemonitor@wolfgangmoser.eu`)                                                                                                                                 |
| Retention   | DynamoDB TTL: 90 days after creation, but not before the related journey's TTL; deleted with the journey or account. SQS messages: 4 days (dead-letter queue 14 days)                                                                                         |
| SES sandbox | While the AWS account is in the SES sandbox, each user's address is also registered as an SES recipient identity (AWS sends a confirmation email); removed when the account is deleted. Ends with production access, see [email-and-ses.md](email-and-ses.md) |

### P5 — Profile picture

| Field       | Entry                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Purpose     | Optional avatar in the app                                                                            |
| Legal basis | Art. 6(1)(b) (voluntary upload)                                                                       |
| Data        | JPEG/PNG/GIF up to 500 KB, stored as `<user id>.<ext>` in an S3 bucket (KMS-encrypted, not versioned) |
| Access      | Only through presigned URLs (1 h) issued to the owner; the app keeps the URL in memory only           |
| Retention   | Replaced on re-upload; deleted with the account                                                       |

### P6 — Data export

Self-service JSON export (`exportMyData` plus the Cognito attributes from the browser session). Art.
6(1)(c) with Art. 15 and 20. Nothing is stored; the file is built in the browser.

### P7 — Operation and security logs

| Field       | Entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose     | Run the service, find errors, detect abuse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Legal basis | Art. 6(1)(f): interest in a secure and working service                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Data        | Lambda logs: pseudonymous ids (user, journey, notification), counts, error messages with email addresses masked; request errors that quote client input are logged without their message. API Gateway access logs: request id, time, method, path, status, size — no IP address. CloudTrail event history: every Cognito user-pool call from the browser (sign-up, sign-in, token refresh, password change, account deletion) with IP address, user agent and Cognito user id; SES `CreateEmailIdentity`/`DeleteEmailIdentity` calls with the email address while in the sandbox |
| Recipients  | AWS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Retention   | CloudWatch log groups 14 days; CloudTrail event history 90 days (fixed by AWS)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### P8 — Email to `legal@wolfgangmoser.eu` (all three sites)

| Field                  | Entry                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Purpose                | Answer enquiries and data-protection requests                                                                |
| Legal basis            | Art. 6(1)(f) (answering enquiries); Art. 6(1)(b) for account matters; Art. 6(1)(c) for data-subject requests |
| Data                   | Sender address, name, content, metadata                                                                      |
| Recipients             | NETIM SAS (domain and mail forwarding, France), Proton AG (mailbox, Switzerland)                             |
| Third-country transfer | Switzerland: adequacy decision 2000/518/EC                                                                   |
| Retention              | Deleted once the matter is closed, unless needed in the individual case for legal claims                     |

## Not personal data

- **Scraper / statistics** (`scraper/`): polls fares for a fixed route catalogue derived from the
  station list. No user input or account data is involved.
- **Alerting** (`AlertingStack`): CloudWatch alarm names and metric values forwarded to Pushover; no
  personal data.

## Technical and organisational measures (Art. 32)

- TLS for every connection (CloudFront redirects HTTP to HTTPS, buckets enforce TLS, HSTS on the
  frontend); data at rest encrypted by AWS (DynamoDB, S3 with KMS-managed keys, Cognito).
- Access control: Cognito authorizer on the whole API; every user-scoped resolver checks the stored
  `cognitoSub` against the verified token; CORS limited to the app's origin; internal mutations only
  on the SQS path.
- Least-privilege IAM per Lambda; secrets in SSM SecureStrings, never in templates.
- Data minimisation: no analytics, no third-party scripts or fonts, pseudonymous logs without IP
  addresses, short log retention, TTL on journeys and notifications, uploads checked by content.
- Availability: point-in-time recovery (35 days), alarms to the operator, dependency scanning.
- Self-service export and deletion.
- **To confirm by the operator:** MFA on the AWS root and administrator users and on the GitHub,
  NETIM and Proton accounts.
