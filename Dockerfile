FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

COPY package.json .
RUN npm install

COPY monitor.js .

# Default directories
RUN mkdir -p /config /state

CMD ["node", "monitor.js"]
