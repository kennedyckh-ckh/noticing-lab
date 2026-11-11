# Build stage: compiles the native SQLite module and the Next.js app
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Run stage
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 PD_DB_PATH=/data/pd.sqlite COOKIE_SECURE=1
COPY --from=build /app /app
# The database lives on a mounted persistent disk at /data. Without a disk, data is lost on every redeploy.
RUN mkdir -p /data
VOLUME /data
EXPOSE 3000
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]
