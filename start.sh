#!/bin/sh
set -e

echo "=== Step 1: Pulling schema from database ==="
npx prisma db pull
echo "=== Schema pulled successfully ==="

echo "=== Step 2: Generating Prisma client ==="
npx prisma generate
echo "=== Prisma client generated ==="

echo "=== Step 3: Starting application ==="
exec node src/index.js
