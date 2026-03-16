FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_AGENT_BASE_URL=http://localhost:8000
ARG VITE_AGENT_WS_URL=ws://localhost:8000/voice/ws
ARG VITE_BROWSER_WORKER_BASE_URL=http://localhost:8001

ENV VITE_AGENT_BASE_URL=${VITE_AGENT_BASE_URL}
ENV VITE_AGENT_WS_URL=${VITE_AGENT_WS_URL}
ENV VITE_BROWSER_WORKER_BASE_URL=${VITE_BROWSER_WORKER_BASE_URL}

RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
