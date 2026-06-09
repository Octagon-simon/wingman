FROM node:20-slim

# Required to compile better-sqlite3 native addon
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN mkdir -p data uploads

EXPOSE 3000

CMD ["npm", "start"]
