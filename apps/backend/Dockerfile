# DEVELOPMENT ONLY (used by the root docker-compose.yml). It runs `prisma migrate deploy` on every container start and uses
# `npm install` without the lockfile. Production uses deploy/Dockerfile.backend, which does neither.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY scripts/check-deploy-config.cjs ./scripts/check-deploy-config.cjs
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev && npm install prisma@^5.16.2 --no-save
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node
EXPOSE 4100
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
