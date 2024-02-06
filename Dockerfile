FROM oven/bun:alpine

# Copy your project files
WORKDIR /app
COPY . .

# Command to run your app
CMD ["bun", "run", "index.ts"]
