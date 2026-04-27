FROM public.ecr.aws/lambda/nodejs:24 AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run codegen
RUN npm run build
RUN npm ci --omit=dev || npm ci --production

FROM public.ecr.aws/lambda/nodejs:24
WORKDIR ${LAMBDA_TASK_ROOT}
COPY --from=builder /build/dist/* ./
COPY --from=builder /build/src/schema ./src/schema
COPY --from=builder /build/node_modules ./node_modules
CMD [ "main.handler" ]
