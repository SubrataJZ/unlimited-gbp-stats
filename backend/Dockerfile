FROM node:18-alpine

WORKDIR /app

# Install netcat for checking postgres availability
RUN apk add --no-cache netcat-openbsd

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma

# Install dependencies (both production and dev)
RUN npm ci || npm install

# Copy source code
COPY src ./src

# Copy entrypoint script
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Generate Prisma Client
RUN npx prisma generate

# Expose port
EXPOSE 3001

# Start with entrypoint script that handles database setup
ENTRYPOINT ["./entrypoint.sh"]
