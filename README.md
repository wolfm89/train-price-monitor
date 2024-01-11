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
- [Usage](#usage)
- [Technologies](#technologies)
- [Contributing](#contributing)

## Features

- Find train journeys between two locations (currently only for Deutsche Bahn in Germany)
- Monitor train ticket prices of selected journeys
- Get notified when the ticket price of a journey exceeds a certain threshold
- Sign up and log in securely
- Responsive design for mobile and desktop

## Getting Started

The easiest way to get in touch with this project is by opening it in [Gitpod](https://gitpod.io/):

[![Open in Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/#https://github.com/wolfm89/train-price-monitor)

If you prefer to get a local copy of the project up and running, follow these steps:

1. Clone the repository: `git clone https://github.com/wolfm89/train-price-monitor.git`
2. `cd frontend`
3. Install dependencies: `npm install`
4. Start the development server: `npm run start`

This will start the frontend.
In order to deploy the infrastructure to your AWS account, run the following:

1. `cd infrastructure`
2. Install CDK with `npm install -g aws-cdk`
3. Bootstrap your AWS account: `cdk bootstrap aws://ACCOUNT-NUMBER/us-east-1 aws://ACCOUNT-NUMBER/REGION`
4. Deploy the infrastructure: `npm run cdk deploy`
5. In the CDK output you should note down the values for `FrontendCloudFrontUrl`, `BackendQueueUrl` and `BackendProfileImageBucketName`

The backend can be started by executing the following steps:

1. `cd backend`
2. Install dependencies: `npm install`
3. `PROFILE_IMAGE_BUCKET_NAME=<Bucket name from CDK output> TPM_SQS_QUEUE_URL=<SQS queue URL from CDK output> npm run dev`

## Usage

To use the application, simply sign up and log in. Then, on the search page enter the departure and arrival locations, the desired date and time of travel, and search for journeys. Select the preferred journey by pressing "Watch" and enter the threshold price. On the journeys page you can always find all your monitored journeys along with the current price. Train Price Monitor will periodically (hourly) check the ticket prices and notify you when the price exceeds your threshold. The notifications are shown in the header bar and can be accessed by clicking on the bell icon. For convenience, they are also sent to your email address.

## Technologies

Frontend:

- React
- TypeScript
- Material-UI
- AWS SDK
- AWS Cognito
- urql

Backend:

- Express
- GraphQL Yoga
- Serverless
- DynamoDB
- AWS S3
- AWS SQS
- AWS SES
- AWS Lambda with Docker
- AWS API Gateway

## Contributing

Contributions are welcome! To contribute to this project, please follow these steps:

1. Fork the repository
2. Create a new branch for your feature: `git checkout -b feature/feature-name`
3. Make your changes and commit them: `git commit -m 'Add some feature'`
4. Push your changes to your fork: `git push origin feature/feature-name`
5. Submit a pull request
