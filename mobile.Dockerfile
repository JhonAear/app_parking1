FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json* ./

# Install both deps + devDeps for capacitor CLI usage
RUN npm install

COPY . .

CMD ["sh"]

