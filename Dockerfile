# 未検証: この環境にDockerがないため、ビルド・起動は確認していない
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY migrations ./migrations
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "src/server.ts"]
