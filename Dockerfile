# Node Alpine -- multi-arch (amd64 + arm64)
FROM node:lts-alpine

WORKDIR /app

# Build tools needed for native npm modules
RUN apk add --no-cache wget python3 make g++

# Copy package files first for caching
COPY package.json package-lock.json ./

# Install dependencies
RUN npm install

# Copy the rest of the project
COPY . .

# Build the web app (no Neutralino)
RUN npm run build:web

# Expose Vite preview port
EXPOSE 4173

# Run the built project
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0"]
