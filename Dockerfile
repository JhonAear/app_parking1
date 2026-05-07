FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["sh", "-lc", "node db/migrate.mjs && node server.mjs"]

