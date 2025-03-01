FROM node:18

WORKDIR /app
COPY package*.json ./

COPY main.js /app
COPY data.js /app
COPY helper.js /app
COPY data /app
COPY views /app

RUN apt update
RUN apt upgrade -y
RUN npm install

CMD ["node", "main.js"]