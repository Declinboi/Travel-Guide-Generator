# Multi-stage build for optimized production image
FROM node:24-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install pnpm and dependencies
RUN npm install -g pnpm@latest && \
    pnpm install --frozen-lockfile

# Copy source code
COPY . .

# ✅ IMPORTANT: Explicitly copy fonts (if not already included)
COPY assets/fonts ./assets/fonts

# Build the application
RUN pnpm run build

# Production stage
FROM node:24-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache dumb-init

# Create app user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install pnpm and production dependencies only
RUN npm install -g pnpm@latest && \
    pnpm install --prod --frozen-lockfile && \
    pnpm store prune

# Copy built application from builder
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist

# ✅ CRITICAL: Copy assets folder (fonts) to production stage
COPY --from=builder --chown=nestjs:nodejs /app/assets ./assets

# Switch to non-root user
USER nestjs

# Expose port
EXPOSE 4000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start with memory limits and GC exposure
CMD ["node", "--max-old-space-size=2048", "--expose-gc", "dist/main.js"]