FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "run", "server"]
