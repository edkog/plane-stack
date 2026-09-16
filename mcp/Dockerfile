FROM node:22-alpine

WORKDIR /app

# package.json first so the dependency layer caches unless it changes.
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV MCP_PORT=8790
EXPOSE 8790

CMD ["node", "server.js"]
