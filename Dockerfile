FROM node:18-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY index.js ./
EXPOSE 3003
CMD ["npm", "start"]
