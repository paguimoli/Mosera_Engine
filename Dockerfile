FROM node:20-bookworm-slim AS deps

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json* ./
RUN npm install

FROM node:20-bookworm-slim AS build

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

ARG NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=dummy-publishable-key

ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV SUPABASE_URL=http://localhost:54321
ENV SUPABASE_SERVICE_ROLE_KEY=dummy-service-role-key
ENV SUPABASE_ANON_KEY=dummy-anon-key

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS prod-deps

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/next.config.ts ./next.config.ts

USER node

EXPOSE 3000

CMD ["npm", "run", "start"]
