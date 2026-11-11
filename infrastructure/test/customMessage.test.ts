// The CustomMessage Lambda only rewrites the password-reset mail; every other
// Cognito message must pass through unchanged.
import { handler, CognitoCustomMessageEvent } from '../lambda/custom-message';

function cognitoEvent(triggerSource: string): CognitoCustomMessageEvent {
  return { triggerSource, request: { codeParameter: '{####}' }, response: {} };
}

describe('Cognito custom message', () => {
  test('rewrites the forgot-password mail with a bilingual subject and the code placeholder', async () => {
    const result = await handler(cognitoEvent('CustomMessage_ForgotPassword'));

    expect(result.response.emailSubject).toBe('Train Price Monitor: Passwort zurücksetzen / Reset your password');
    expect(result.response.emailMessage).toContain('{####}');
    expect(result.response.emailMessage).toContain('Passwort');
    expect(result.response.emailMessage).toContain('reset your Train Price Monitor password');
  });

  test.each(['CustomMessage_SignUp', 'CustomMessage_ResendCode', 'CustomMessage_UpdateUserAttribute'])(
    'leaves %s untouched',
    async (triggerSource) => {
      const result = await handler(cognitoEvent(triggerSource));

      expect(result.response).toEqual({});
    }
  );
});
