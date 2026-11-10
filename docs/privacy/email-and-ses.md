# Email: SES production access, DNS authentication, sending as `legal@`

Everything here changes AWS or DNS settings and is done by the operator, not by CI. Region:
`eu-central-1`.

## Current state (November 2026)

- The AWS account is in the **SES sandbox**: SES only delivers to verified addresses. As a
  workaround, `createUser` registers every new user's address as an SES email identity, so AWS sends
  each user an extra "Amazon Web Services – Email Address Verification Request" mail, and
  `deleteUser` removes the identity again.
- Until this change the Lambda role lacked `ses:DeleteEmailIdentity`, so identities of deleted
  accounts were **never removed**. They have to be cleaned up (step 6 below).
- Notification emails are sent from `SES_FROM_EMAIL`, set from the GitHub secret
  `CDK_SES_FROM_EMAIL`. It must be `trainpricemonitor@wolfgangmoser.eu` (the address named in the
  privacy policy) and verified in SES.
- Cognito sends sign-up and password-reset emails itself, from `no-reply@verificationemail.com`.
- DNS at NETIM: MX `mx1.netim.net` / `mx2.netim.net`, SPF `v=spf1 ip4:185.26.104.0/22 ~all`, no
  DKIM for SES, no DMARC. `legal@`, `trainpricemonitor@` (and later `dmarc@`) are NETIM forwarding
  aliases to the Proton mailbox.

## Leaving the sandbox

1. **Domain identity with DKIM.** SES console → _Identities_ → _Create identity_ → _Domain_
   `wolfgangmoser.eu`, _Easy DKIM_, RSA 2048. Publish the three CNAME records SES shows
   (`<token>._domainkey.wolfgangmoser.eu` → `<token>.dkim.amazonses.com`) at NETIM and wait for
   "Verified". The domain identity also covers `trainpricemonitor@wolfgangmoser.eu`.
2. **Custom MAIL FROM (optional, recommended).** On the domain identity, set
   `bounce.wolfgangmoser.eu` and publish `MX 10 feedback-smtp.eu-central-1.amazonses.com` and
   `TXT "v=spf1 include:amazonses.com ~all"` for that subdomain. Bounces then align with the domain.
3. **DMARC.** Create the NETIM alias `dmarc@wolfgangmoser.eu`, then publish
   `_dmarc.wolfgangmoser.eu TXT "v=DMARC1; p=none; rua=mailto:dmarc@wolfgangmoser.eu"`. Move to
   `p=quarantine` once the reports show SES (and, after the next section, Proton) passing.
4. **Suppression list.** SES console → _Configuration_ → _Suppression list_: make sure account-level
   suppression covers bounces and complaints.
5. **Request production access.** SES console → _Get set up_ → _Request production access_, or:
   ```bash
   aws sesv2 put-account-details --region eu-central-1 \
     --production-access-enabled --mail-type TRANSACTIONAL \
     --website-url https://tpm.wolfgangmoser.eu \
     --use-case-description "Train Price Monitor is a free, non-commercial app. Users sign up with a \
   Cognito-verified email address and set up price alerts for train journeys. We only send the alerts \
   they configured (price above their limit, journey expired, journey no longer trackable), a few per \
   user per month. Every user can switch email alerts off in their profile and delete their account. \
   Bounces and complaints are handled by the account-level suppression list." \
     --additional-contact-email-addresses legal@wolfgangmoser.eu \
     --contact-language EN
   ```
   AWS answers within 96 hours.
6. **Switch the workaround off.** After approval, set the repository variable
   `CDK_SES_PRODUCTION_ACCESS=1` (GitHub → Settings → Secrets and variables → Actions → Variables)
   and deploy. The Lambdas then get `SES_SANDBOX=false` and lose `ses:CreateEmailIdentity` /
   `ses:DeleteEmailIdentity`. Then delete the per-user identities, keeping the sender and domain:
   ```bash
   aws sesv2 list-email-identities --region eu-central-1 \
     --query "EmailIdentities[?IdentityType=='EMAIL_ADDRESS'].IdentityName" --output text \
     | tr '\t' '\n' | grep -v -x -F 'trainpricemonitor@wolfgangmoser.eu' > /tmp/ses-user-identities.txt
   wc -l /tmp/ses-user-identities.txt   # review the list before deleting
   xargs -n1 aws sesv2 delete-email-identity --region eu-central-1 --email-identity < /tmp/ses-user-identities.txt
   rm /tmp/ses-user-identities.txt
   ```
7. **Update the privacy policy** (landing-page repo): remove the paragraph about the SES
   confirmation email in section 5, and update the date.
8. **Optional: Cognito mail through SES.** Configure the user pool with
   `email: cognito.UserPoolEmail.withSES({ fromEmail: 'trainpricemonitor@wolfgangmoser.eu', sesRegion:
'eu-central-1', sesVerifiedDomain: 'wolfgangmoser.eu' })`. That replaces
   `no-reply@verificationemail.com` and Cognito's low default sending quota. Update the privacy
   policy (sender of the confirmation emails) in the same release.

## Sending as `legal@`

Replies to data-protection requests must not reveal the private Proton address. Options:

- **Proton custom domain** (needs a paid Proton plan). Add `wolfgangmoser.eu` in Proton and
  publish the records the wizard shows (verification TXT, DKIM CNAMEs, SPF include, MX if Proton
  should receive directly). If the MX moves to Proton, the NETIM forwarding is no longer needed and
  NETIM drops out of the mail path — update the privacy policy (sections on email contact and
  recipients) accordingly.
- **NETIM mailbox** with SMTP in a desktop mail client, if the NETIM plan includes one; keep the SPF
  record covering NETIM's servers.

Whichever is chosen: extend SPF for the new sender, add its DKIM records, and check the DMARC
reports before tightening the policy.
