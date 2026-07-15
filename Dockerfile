FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install
RUN pnpm install --frozen-lockfile
COPY index.js ./
COPY matriculas.service.js ./
EXPOSE 3003
CMD ["pnpm", "start"]
