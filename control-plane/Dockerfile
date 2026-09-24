# syntax=docker/dockerfile:1
# Build: docker compose build (passes ../dashboard as the named context "dashboard").
# Without compose: docker build --build-context dashboard=../dashboard .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# The web dashboard, served by the API at /dashboard/.
FROM node:22-alpine AS dashboard-build
WORKDIR /dashboard
COPY --from=dashboard package.json package-lock.json ./
RUN npm ci
COPY --from=dashboard index.html tsconfig.json vite.config.ts ./
COPY --from=dashboard src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
ENV DASHBOARD_DIR=/app/dashboard
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=dashboard-build /dashboard/dist ./dashboard
COPY package.json ./
COPY migrations ./migrations
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/src/server.js"]
