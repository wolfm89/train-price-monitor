// The CustomMessage Lambda only rewrites the password-reset mail; every other
// Cognito message must pass through unchanged.
import { handler, CognitoCustomMessageEvent } from '../lambda/custom-message';

beforeAll(() => {
  process.env.APP_NAME = 'Train Price Monitor';
});

function cognitoEvent(triggerSource: string): CognitoCustomMessageEvent {
  return { triggerSource, request: { codeParameter: '{####}' }, response: {} };
}

describe('Cognito custom message', () => {
  test('rewrites the forgot-password mail in English with the code placeholder', async () => {
    const result = await handler(cognitoEvent('CustomMessage_ForgotPassword'));

    expect(result.response.emailSubject).toBe('Train Price Monitor: Reset your password');
    expect(result.response.emailMessage).toContain('{####}');
    expect(result.response.emailMessage).toContain('use this code to reset your Train Price Monitor password');
    expect(result.response.emailMessage).not.toMatch(/Passwort|Guten Tag/);
  });

  test.each(['CustomMessage_SignUp', 'CustomMessage_ResendCode', 'CustomMessage_UpdateUserAttribute'])(
    'leaves %s untouched',
    async (triggerSource) => {
      const result = await handler(cognitoEvent(triggerSource));

      expect(result.response).toEqual({});
    }
  );
});
