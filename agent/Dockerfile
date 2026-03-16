FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

ENV PORT=8080

EXPOSE 8080

CMD ["node", "dist/server.js"]
