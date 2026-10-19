FROM node:22-alpine
RUN apk add --no-cache fontconfig ttf-dejavu
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
