FROM public.ecr.aws/lambda/nodejs:24

# Copy the pre-built ESM bundle (produced by 'npm run build' in scraper/)
COPY dist/poller/index.mjs ${LAMBDA_TASK_ROOT}/

CMD ["index.handler"]
