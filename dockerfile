# Use the official Bun image with Alpine as the base image
FROM oven/bun:1-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Create a volume for the database
VOLUME /usr/src/app/data

# Set environment variable for the database path
ENV DB_PATH=/usr/src/app/data/mr_stats.sqlite

# Install Git, Chromium, and other dependencies
RUN apk add --no-cache \
    git \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    nodejs \
    npm

# Set environment variable to tell Puppeteer to use the installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Clone the repository using a more robust method
RUN git clone https://github.com/pujan-modha/mr-backend.git . || \
    (git init && git remote add origin https://github.com/pujan-modha/mr-backend.git && \
     git fetch --depth=1 origin && git checkout origin/main)

# Install dependencies
RUN bun install

# Expose the port the app runs on (adjust if necessary)
EXPOSE 5000

# Command to run the application
CMD ["bun", "run", "index.ts"]