import { GraphQLError } from 'graphql';

/** Same limit as the upload form on the profile page. */
export const MAX_PROFILE_PICTURE_BYTES = 512 * 1024;

const ALLOWED_FORMATS = [
  { contentType: 'image/jpeg', extension: 'jpg', signature: [0xff, 0xd8, 0xff] },
  { contentType: 'image/png', extension: 'png', signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // "GIF8", shared by GIF87a and GIF89a
  { contentType: 'image/gif', extension: 'gif', signature: [0x47, 0x49, 0x46, 0x38] },
];

export interface ValidatedProfilePicture {
  contentType: string;
  extension: string;
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/**
 * Checks an uploaded picture on the server instead of trusting the browser's
 * MIME type and file name: the format is taken from the file's leading bytes,
 * and the stored object's extension and content type are derived from it.
 */
export function validateProfilePicture(body: Uint8Array): ValidatedProfilePicture {
  if (body.length === 0) {
    throw badInput('The picture is empty.');
  }
  if (body.length > MAX_PROFILE_PICTURE_BYTES) {
    throw badInput('The picture is larger than 500 KB.');
  }
  const format = ALLOWED_FORMATS.find(({ signature }) => signature.every((byte, index) => body[index] === byte));
  if (!format) {
    throw badInput('Only JPEG, PNG and GIF pictures are allowed.');
  }
  return { contentType: format.contentType, extension: format.extension };
}
