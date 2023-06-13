FROM public.ecr.aws/lambda/nodejs:18 as builder
WORKDIR /build
COPY . .
RUN npm ci
# Generate code from GraphQL schema
RUN npm run codegen
RUN npm ci --production
RUN npm run build

FROM public.ecr.aws/lambda/nodejs:18
WORKDIR ${LAMBDA_TASK_ROOT}
COPY --from=builder /build/dist/* ./
COPY --from=builder /build/src/schema ./src/schema
CMD [ "main.handler" ]
