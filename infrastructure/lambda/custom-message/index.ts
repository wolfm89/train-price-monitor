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

const PASSWORD_RESET = {
  subject: 'Train Price Monitor: Passwort zurücksetzen / Reset your password',
  body: (code: string): string =>
    'Guten Tag,<br><br>' +
    'mit diesem Code setzen Sie Ihr Passwort für Train Price Monitor zurück:<br><br>' +
    `<b>${code}</b><br><br>` +
    'Der Code ist nur kurze Zeit gültig. Wenn Sie kein neues Passwort angefordert haben, ' +
    'ignorieren Sie diese E-Mail.<br><br>' +
    'Hello,<br><br>' +
    'use this code to reset your Train Price Monitor password:<br><br>' +
    `<b>${code}</b><br><br>` +
    'The code expires after a short time. If you did not request a new password, ignore this email.',
};

export async function handler(event: CognitoCustomMessageEvent): Promise<CognitoCustomMessageEvent> {
  if (event.triggerSource === 'CustomMessage_ForgotPassword') {
    event.response.emailSubject = PASSWORD_RESET.subject;
    event.response.emailMessage = PASSWORD_RESET.body(event.request.codeParameter);
  }
  return event;
}
