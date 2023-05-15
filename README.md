# Train Price Monitor
<p align="center">
  <img src="public/logo192.png" width="20%"/></br>
  <a href="https://www.gnu.org/licenses/gpl-3.0"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg"></a>
  <a href="https://github.com/wolfm89/train-price-monitor/tree/develop"><img src="https://badge.fury.io/gh/tterb%2FHyde.svg"></a>
</p>

Train price monitoring WebApp that sends notifications to users when prices increase above a certain threshold, built on a serverless and low-cost tech stack using React, TypeScript, and AWS services such as API Gateway, Lambda, DynamoDB, and SNS.

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

To get a local copy of the project up and running, follow these steps:

1. Clone the repository: `git clone https://github.com/wolfm89/train-price-monitor.git`
2. Install dependencies: `npm install`
3. Start the development server: `npm start`

## Usage

To use the application, simply sign up and log in. Then, enter the departure and arrival locations, the desired date and time of travel, and the threshold price. Train Price Monitor will periodically check the ticket prices and notify you when the price exceeds your threshold.

## Technologies

- React
- TypeScript
- Material-UI

## Contributing

Contributions are welcome! To contribute to this project, please follow these steps:

1. Fork the repository
2. Create a new branch for your feature: `git checkout -b feature/feature-name`
3. Make your changes and commit them: `git commit -m 'Add some feature'`
4. Push your changes to your fork: `git push origin feature/feature-name`
5. Submit a pull request
