FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
RUN mkdir -p data
EXPOSE 3000
ENV PORT=3000
ENV DB_PATH=/app/data/sylvenka.db
CMD ["node", "src/server.js"]
