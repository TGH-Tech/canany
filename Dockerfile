# Production image for the whole app: the Telegram bot and the web board run in
# one Node process (src/index.js). No compile step — plain CommonJS.
FROM node:22-alpine

# Prisma's query engine on Alpine links against OpenSSL 3.
RUN apk add --no-cache openssl

ENV NODE_ENV=production
WORKDIR /app
RUN chown node:node /app
USER node

# Lockfile and schema first, so the dependency layer (and its postinstall
# `prisma generate`, which needs the schema) is cached until either changes.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

# Must match `port` in atlas.json and the constant in src/config/index.js.
EXPOSE 8080
CMD ["node", "src/index.js"]
