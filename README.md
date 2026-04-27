# Train Price Monitor

<p align="center">
  <img src="frontend/public/logo192.png" width="20%"/></br>
  <a href="https://www.gnu.org/licenses/gpl-3.0"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg"></a>
  <a href="https://github.com/wolfm89/train-price-monitor/tags"><img src="https://img.shields.io/github/v/tag/wolfm89/train-price-monitor?label=version&color=darkgreen"></a>
</p>

Train price monitoring WebApp that sends notifications to users when prices increase above a certain threshold, built on a serverless and low-cost tech stack using React, TypeScript, GraphQL, Docker and AWS services such as API Gateway, Lambda, DynamoDB, S3, SQS, and SNS.

## Table of Contents

- [Features](#features)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Usage](#usage)
- [Technologies](#technologies)
- [Contributing](#contributing)

## Features

- Find train journeys between two locations (currently only for Deutsche Bahn in Germany)
- Browse earlier and later departures with pagination controls in search results
- Monitor train ticket prices of selected journeys
- Get notified when the ticket price of a journey exceeds a certain threshold
- Automatic cleanup of price-alert notifications when a monitored journey expires
- Sign up and log in securely
- Responsive design for mobile and desktop

## Getting Started

This project uses [mise](https://mise.jdx.dev/) for Node.js version management. Run `mise install` at the repository root before anything else.

To get a local copy of the project up and running, follow these steps:

1. Clone the repository: `git clone https://github.com/wolfm89/train-price-monitor.git`
2. Install mise and run `mise install` at the root
3. `cd frontend && npm install`
4. Start the frontend dev server: `npm run dev`

In order to deploy the infrastructure to your AWS account, run the following:

1. Set the required CDK environment variables (see [Environment Variables](#environment-variables))
2. `cd infrastructure`
3. Install CDK with `npm install -g aws-cdk`
4. Bootstrap your AWS account: `cdk bootstrap aws://ACCOUNT-NUMBER/us-east-1 aws://ACCOUNT-NUMBER/REGION`
5. Deploy the infrastructure: `npm run cdk deploy -- --all`
6. In the CDK output you should note down the values for `FrontendCloudFrontUrl`, `BackendQueueUrl` and `BackendProfileImageBucketName`

The backend can be started locally with the following steps:

1. `cd backend`
2. Install dependencies: `npm install`
3. `LOCAL_DEV=1 PROFILE_IMAGE_BUCKET_NAME=<Bucket name from CDK output> TPM_SQS_QUEUE_URL=<SQS queue URL from CDK output> npm run dev`

Alternatively, use `mise run //backend:dev` from the repository root (mise sets `LOCAL_DEV=1` automatically).

## Environment Variables

| Variable                     | Module           | Description                                                              |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `PROFILE_IMAGE_BUCKET_NAME`  | Backend          | S3 bucket name for profile images                                        |
| `TPM_SQS_QUEUE_URL`          | Backend          | SQS queue URL for journey monitor updates                                |
| `SES_FROM_EMAIL`             | Backend (Lambda) | Sender address for SES notification emails                               |
| `FRONTEND_URL`               | Backend (Lambda) | Frontend base URL injected into notification links                       |
| `LOCAL_DEV`                  | Backend          | Set to `1` to start an HTTP server instead of exporting a Lambda handler |
| `REACT_APP_GRAPHQL_ENDPOINT` | Frontend         | API Gateway endpoint URL                                                 |
| `CDK_APP_NAME`               | Infrastructure   | Application name (overrides CDK context)                                 |
| `CDK_DOMAIN_NAME`            | Infrastructure   | Custom domain name for the deployment                                    |
| `CDK_SES_FROM_EMAIL`         | Infrastructure   | Sender email injected as Lambda env var                                  |

## Usage

To use the application, simply sign up and log in. Then, on the search page enter the departure and arrival locations, the desired date and time of travel, and search for journeys. Select the preferred journey by pressing "Watch" and enter the threshold price. On the journeys page you can always find all your monitored journeys along with the current price. Train Price Monitor will periodically (hourly) check the ticket prices and notify you when the price exceeds your threshold. The notifications are shown in the header bar and can be accessed by clicking on the bell icon. For convenience, they are also sent to your email address.

## Technologies

Frontend:

- React 19
- TypeScript
- Material-UI v7
- Vite
- AWS SDK
- AWS Cognito
- urql

Backend:

- GraphQL Yoga
- Native AWS Lambda handler (API Gateway v1/v2 + SQS)
- db-vendo-client (Deutsche Bahn journey data)
- DynamoDB (via dynamodb-toolbox v2)
- AWS S3
- AWS SQS
- AWS SES
- AWS Lambda with Docker
- AWS API Gateway

Infrastructure:

- AWS CDK v2
- AWS Cognito
- Node.js 24

## Contributing

Contributions are welcome! To contribute to this project, please follow these steps:

1. Fork the repository
2. Create a new branch for your feature: `git checkout -b feature/feature-name`
3. Make your changes and commit them: `git commit -m 'Add some feature'`
4. Push your changes to your fork: `git push origin feature/feature-name`
5. Submit a pull request
