# Use the official Node.js 18.x base image
FROM public.ecr.aws/lambda/nodejs:18

# Set the working directory inside the container
WORKDIR /var/task

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies
RUN npm ci --production

# Copy the rest of the application code
COPY . .

# Set the command to execute your application
CMD [ "main.handler" ]
