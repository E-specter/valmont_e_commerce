# Frontend de Valmont: Astro con @astrojs/node en modo standalone (D-024, D-029).
# Basado en la receta multietapa oficial: https://docs.astro.build/en/recipes/docker/
# Sin variables de entorno de la aplicación: la configuración llega en tiempo de ejecución.

FROM node:26.12.1-trixie-slim AS base
WORKDIR /app
# Solo los manifiestos: las capas de dependencias se reutilizan mientras no cambien.
COPY package.json package-lock.json ./

FROM base AS prod-deps
RUN npm ci --omit=dev

FROM base AS build
RUN npm ci
COPY . .
RUN npm run build

FROM node:26.12.1-trixie-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4321
# La imagen slim no trae curl: comprobación con el fetch de Node.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "./dist/server/entry.mjs"]
