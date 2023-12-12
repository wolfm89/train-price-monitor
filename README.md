# Train Price Monitor

<p align="center">
  <img src="frontend/public/logo192.png" width="20%"/></br>
  <a href="https://www.gnu.org/licenses/gpl-3.0"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg"></a>
  <a href="https://github.com/wolfm89/train-price-monitor/tree/develop"><img src="https://badge.fury.io/gh/tterb%2FHyde.svg"></a>
</p>

Train price monitoring WebApp that sends notifications to users when prices increase above a certain threshold, built on a serverless and low-cost tech stack using React, TypeScript, and AWS services such as API Gateway, Lambda, DynamoDB, S3, and SNS.

## Table of Contents

- [Features](#features)
- [Getting Started](#getting-started)
- [Usage](#usage)
- [Technologies](#technologies)
- [Contributing](#contributing)

## Features

- Monitor train ticket prices between two locations
- Get notified when the ticket price exceeds a certain threshold
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
3. Bootstrap your AWS account: `cdk bootstrap aws://ACCOUNT-NUMBER/REGION`
4. Deploy the infrastructure: `npm run cdk deploy`
5. In the CDK output you should note down both the `FrontendCloudFrontUrl` and the `BackendProfileImageBucketName`

The backend can be started by executing the following steps:

1. `cd backend`
2. Install dependencies: `npm install`
3. `PROFILE_IMAGE_BUCKET_NAME=<Bucket name from CDK output> npm run dev`

## Usage

To use the application, simply sign up and log in. Then, enter the departure and arrival locations, the desired date and time of travel, and the threshold price. Train Price Monitor will periodically check the ticket prices and notify you when the price exceeds your threshold.

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
- S3
- AWS Lambda with Docker
- AWS API Gateway

## Contributing

Contributions are welcome! To contribute to this project, please follow these steps:

1. Fork the repository
2. Create a new branch for your feature: `git checkout -b feature/feature-name`
3. Make your changes and commit them: `git commit -m 'Add some feature'`
4. Push your changes to your fork: `git push origin feature/feature-name`
5. Submit a pull request
