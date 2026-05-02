FROM node:20-alpine

WORKDIR /app

# Install OpenSSL 1.1 and other dependencies required for Prisma
RUN apk add --no-cache openssl libc6-compat

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy Prisma schema and migrations
COPY prisma ./prisma/

# Copy source code
COPY . .

# Generate Prisma client
RUN npm run prisma:generate

# Build the application (if using TypeScript/Next.js)
# RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "dev"]
