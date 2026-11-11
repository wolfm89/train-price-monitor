'use strict';

// Cognito CustomMessage trigger. The user pool sends its mail through SES
// (EmailSendingAccount DEVELOPER), which is the prerequisite for setting
// emailSubject/emailMessage here. Only the password-reset wording is replaced;
// every other trigger source is returned untouched, so the confirmation mail
// keeps the pool's verification template.
//
// `request.codeParameter` is Cognito's placeholder (usually "{####}"); Cognito
// substitutes the real code after the function returns.

const MESSAGES = {
  CustomMessage_ForgotPassword: {
    subject: 'Train Price Monitor: Passwort zurücksetzen / Reset your password',
    body: (code) =>
      'Guten Tag,<br><br>' +
      'mit diesem Code setzen Sie Ihr Passwort für Train Price Monitor zurück:<br><br>' +
      `<b>${code}</b><br><br>` +
      'Der Code ist nur kurze Zeit gültig. Wenn Sie kein neues Passwort angefordert haben, ' +
      'ignorieren Sie diese E-Mail.<br><br>' +
      'Hello,<br><br>' +
      'use this code to reset your Train Price Monitor password:<br><br>' +
      `<b>${code}</b><br><br>` +
      'The code expires after a short time. If you did not request a new password, ignore this email.',
  },
};

exports.handler = async (event) => {
  const message = MESSAGES[event.triggerSource];
  if (message) {
    event.response.emailSubject = message.subject;
    event.response.emailMessage = message.body(event.request.codeParameter);
  }
  return event;
};
