# Security policy

## Supported versions

The latest `main` branch and the most recent tagged release receive security fixes. The hosted
instance is covered by the same code and configuration as `main`.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting**:

1. Open the repository's **Security** tab.
2. Select **Advisories** → **Report a vulnerability**.
3. Include the affected component or endpoint, a minimal reproduction, the impact you observed and
   any sanitized logs.

Do not open a public issue for a vulnerability, and do not include access tokens, cookies, email
addresses, raw request bodies or other personal data in the report.

If private reporting is unavailable, contact the maintainer through the GitHub profile linked from
the repository rather than posting details publicly.

## Scope

In scope:

- Cognito sign-up/sign-in, JWT validation and the API Gateway authorizer;
- every GraphQL resolver that reads or writes user-scoped data;
- S3 profile-image uploads and presigned URLs;
- infrastructure IAM, secret handling and the deploy workflow;
- the scraper/analytics data paths where a malicious input could affect the published dataset.

Out of scope:

- reports that require a compromised AWS account or GitHub account;
- rate-limit or denial-of-service findings without a practical impact;
- dependency advisories already tracked by Dependabot, unless you have a working exploit;
- the public privacy policy or legal pages (use the contact in [docs/privacy.md](docs/privacy.md)).

## What to expect

This is a personal open-source project. Reports are reviewed on a best-effort basis; there is no
bug bounty. Please allow time for a fix before public disclosure. Credit is given in the advisory
unless you prefer to remain anonymous.
