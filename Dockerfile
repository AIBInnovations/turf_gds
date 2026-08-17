FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
# One image, two processes. The API serves requests; the worker runs the
# recurring jobs (outbox delivery, hold recovery, payout reconciliation).
# Run the worker by overriding the command with: node dist/worker.js
CMD ["node","dist/server.js"]
