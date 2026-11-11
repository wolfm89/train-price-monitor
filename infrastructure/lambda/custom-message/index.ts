// Cognito CustomMessage trigger. The user pool sends its mail through SES
// (EmailSendingAccount DEVELOPER), which is the prerequisite for setting
// emailSubject/emailMessage here. Only the password-reset wording is replaced;
// every other trigger source is returned untouched, so the confirmation mail
// keeps the pool's verification template.
//
// `request.codeParameter` is Cognito's placeholder (usually "{####}"); Cognito
// substitutes the real code after the function returns.

export interface CognitoCustomMessageEvent {
  triggerSource: string;
  request: { codeParameter: string };
  response: { emailSubject?: string; emailMessage?: string };
}

function passwordResetBody(appName: string, code: string): string {
  return (
    'Hello,<br><br>' +
    `use this code to reset your ${appName} password:<br><br>` +
    `<b>${code}</b><br><br>` +
    'The code expires after a short time. If you did not request a new password, ignore this email.'
  );
}

export async function handler(event: CognitoCustomMessageEvent): Promise<CognitoCustomMessageEvent> {
  if (event.triggerSource === 'CustomMessage_ForgotPassword') {
    // Set by the stack from the app_name context, like the confirmation subject.
    const appName = process.env.APP_NAME ?? 'Train Price Monitor';
    event.response.emailSubject = `${appName}: Reset your password`;
    event.response.emailMessage = passwordResetBody(appName, event.request.codeParameter);
  }
  return event;
}
