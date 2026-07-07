FROM mcr.microsoft.com/playwright:v1.61.0-noble AS base
ENV CI="true"
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1"
RUN npm install -g pnpm@11.7.0 --no-audit --no-fund
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/browser-runner/package.json packages/browser-runner/package.json
RUN pnpm install --frozen-lockfile --trust-lockfile --network-concurrency=1 --child-concurrency=1

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY packages/browser-runner/tsconfig.json packages/browser-runner/tsconfig.json
COPY packages/browser-runner/tsdown.config.ts packages/browser-runner/tsdown.config.ts
COPY packages/browser-runner/src packages/browser-runner/src
RUN pnpm --filter ./packages/browser-runner build

FROM base AS runner
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=deps /app/packages/browser-runner/node_modules packages/browser-runner/node_modules
COPY --from=build /app/packages/shared packages/shared
COPY --from=build /app/packages/browser-runner packages/browser-runner
USER pwuser
CMD ["node", "packages/browser-runner/dist/index.js"]
