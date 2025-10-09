# Lightweight production image for CozyQuiz backend
FROM node:20-alpine

WORKDIR /app

# Install only production deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy source
COPY . .

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "server.js"]
