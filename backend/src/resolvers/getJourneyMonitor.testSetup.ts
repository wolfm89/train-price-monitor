// `user.ts` validates this at module load. Keep the test independent of a local
// `.env` file and of the CI environment, and do not overwrite a real value.
process.env.PROFILE_IMAGE_BUCKET_NAME ??= 'test';
