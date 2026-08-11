FROM node:20-alpine

# Prisma needs openssl on alpine
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

# At startup: pull the schema from the live database, generate the Prisma
# client, then start the app. DATABASE_URL is available at runtime (set in
# Render's environment variables), not at build time.
CMD sh -c "npx prisma db pull && npx prisma generate && npm start"
