# Handling data-subject requests

Requests arrive at `legal@wolfgangmoser.eu` (forwarded to Proton). Answer from an address that does
not reveal the private mailbox (see [email-and-ses.md](email-and-ses.md#sending-as-legal)).

## Deadlines and identity

- Answer without undue delay, **at the latest within one month** of receipt (Art. 12(3) GDPR). The
  deadline can be extended by two further months for complex or numerous requests; tell the person
  within the first month and give the reason.
- Free of charge. Only manifestly unfounded or excessive requests may be refused or charged
  (Art. 12(5)); document why.
- **Identity:** a request about a Train Price Monitor account must come from the account's email
  address, or be confirmed by replying to a message sent to that address. Ask for nothing more than
  that. Requests about the landing page or blog can usually only be answered with "no data stored"
  (the sites keep no logs of their own; GitHub's logs are GitHub's).
- If you need proof that a request was handled, keep a short note (date received, type, date
  answered) instead of copies of the data, and delete it together with the correspondence once it
  is no longer needed (see the retention rule in the privacy policy).

## Finding the account

```bash
export AWS_REGION=eu-central-1 POOL_ID=<user pool id> TABLE=TrainPriceMonitor
aws cognito-idp list-users --user-pool-id "$POOL_ID" --filter 'email = "person@example.com"'
# Note `Username` and the `custom:id` attribute (the app's user id, also the DynamoDB key).
```

## Access (Art. 15) and portability (Art. 20)

The user can download everything from **Profile → Your data → Download my data** (DynamoDB data,
profile-picture link and the Cognito attributes of the session). For a request by email:

1. Ask whether the self-service export is enough; it usually is.
2. Otherwise collect it manually:
   ```bash
   aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username <Username>
   aws dynamodb query --table-name "$TABLE" \
     --key-condition-expression 'pk = :pk' --expression-attribute-values '{":pk":{"S":"USER#<custom:id>"}}'
   aws s3 ls "s3://<profile image bucket>/<custom:id>."
   aws sesv2 get-suppressed-destination --email-address person@example.com   # bounce/complaint list
   aws sesv2 get-email-identity --email-identity person@example.com          # sandbox identity, if any
   ```
3. Search the last 14 days of Lambda logs for the user id if the person asks about logs
   (CloudWatch Logs Insights on `InfrastructureStack-BackendLambdaLogs*` and
   `InfrastructureStack-BackendRefresherLambdaLogs*`, filter on `userId`).
4. Send the data together with the information Art. 15(1) requires — purposes, categories,
   recipients, retention, rights, source. The privacy policy covers all of it; link the relevant
   sections.

## Rectification (Art. 16)

- Travel preferences, notification settings and the picture are editable in the app.
- **Names and email address cannot be changed** in the current Cognito user pool (names are
  immutable; the email is not synchronised to DynamoDB). Offer to delete the account so that the
  person can register again with the correct data, or — for the email address only — change it with
  `admin-update-user-attributes` **and** update `email` in the `USER#<id>/METADATA#` item. Track the
  pool migration in [README.md](README.md#open-items).

## Erasure (Art. 17)

The user can delete the account under **Profile → Danger zone**. That removes the DynamoDB items,
the picture, the SES sandbox identity and then the Cognito user. If the last step failed (the app
then asks the user to write to `legal@`), or for a request by email:

```bash
# 1. App data: every item in the user's partition
aws dynamodb query --table-name "$TABLE" --key-condition-expression 'pk = :pk' \
  --expression-attribute-values '{":pk":{"S":"USER#<custom:id>"}}' --projection-expression 'pk, sk'
aws dynamodb delete-item --table-name "$TABLE" --key '{"pk":{"S":"USER#<custom:id>"},"sk":{"S":"<sk>"}}'  # per item
# 2. Profile picture
aws s3 rm "s3://<profile image bucket>/" --recursive --exclude '*' --include '<custom:id>.*'
# 3. SES recipient identity (sandbox only) and suppression-list entry, if present
aws sesv2 delete-email-identity --email-identity person@example.com
aws sesv2 delete-suppressed-destination --email-address person@example.com
# 4. Login
aws cognito-idp admin-delete-user --user-pool-id "$POOL_ID" --username <Username>
```

Afterwards:

- Logs (14 days) and the CloudTrail event history (90 days) expire on their own; they are not
  edited.
- Point-in-time recovery keeps the deleted items for up to 35 days. They are not restored except to
  recover from an incident; after such a restore, repeat the deletion.
- Delete the person's emails once the request is answered, unless needed for legal claims.
- Confirm the deletion to the person.

## Restriction (Art. 18) and objection (Art. 21)

- **Restriction:** the app has no switch that pauses processing for one account. Switching off
  email notifications (`emailNotificationsEnabled = false`) only stops the emails; the hourly
  refresher keeps querying DB (and Decodo) for every watched journey and keeps writing price
  snapshots and in-app notifications. To restrict processing to storage, export the account's
  items first (see above), then delete the watched journeys so the refresher has nothing to
  process, switch off email notifications, and leave the remaining items untouched. Note the
  restriction and tell the person before lifting it. If restrictions become common, add a
  per-user pause flag that the refresher honours.
- **Objection** applies to processing based on legitimate interests (logs, hosting, emails to
  `legal@`). Stop unless there are compelling legitimate grounds or the data is needed for legal
  claims; logs expire after 14 days anyway. Everything needed to run the account is based on
  Art. 6(1)(b); a person who no longer wants that can delete the account.

## Breaches (Art. 33/34)

If personal data is exposed (for example leaked credentials or a misconfigured bucket): contain it,
assess the risk, and notify BayLDA within 72 hours unless the breach is unlikely to result in a risk
to the persons (<https://www.lda.bayern.de>, online form). Inform the affected users without undue
delay if the risk is high. Record every breach, including the ones not notified (Art. 33(5)).
