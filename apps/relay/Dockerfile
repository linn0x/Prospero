# Node 22.14.0 is an explicit maintained LTS patch release; no floating image tags are used.
FROM node:22.14.0-alpine3.21 AS build
WORKDIR /srv/prospero
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json ./packages/protocol/
COPY apps/relay/package.json apps/relay/tsconfig.json ./apps/relay/
RUN npm ci --ignore-scripts --include-workspace-root --workspace @prospero/protocol --workspace @prospero/relay
COPY packages/protocol ./packages/protocol
COPY apps/relay ./apps/relay
RUN npm run build --workspace @prospero/protocol && npm run build --workspace @prospero/relay

FROM build AS production-deps
RUN npm prune --omit=dev --ignore-scripts --workspace @prospero/relay --include-workspace-root

FROM node:22.14.0-alpine3.21 AS runtime
WORKDIR /srv/prospero
ENV NODE_ENV=production
COPY --from=production-deps /srv/prospero/node_modules ./node_modules
COPY --from=build /srv/prospero/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /srv/prospero/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /srv/prospero/apps/relay/package.json ./apps/relay/package.json
COPY --from=production-deps /srv/prospero/apps/relay/node_modules ./apps/relay/node_modules
COPY --from=build /srv/prospero/apps/relay/dist ./apps/relay/dist
COPY --from=build /srv/prospero/apps/relay/migrations ./apps/relay/migrations
USER node
WORKDIR /srv/prospero/apps/relay
EXPOSE 8787
CMD ["node", "dist/main.js"]
