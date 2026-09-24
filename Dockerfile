# ===== base =====
FROM node:24-alpine AS base
ENV NODE_ENV=production
WORKDIR /app

# ===== deps (إعادة استخدام الطبقة عند ثبات الـ lockfile) =====
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ===== runtime =====
FROM base
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# تشغيل كمستخدم غير root
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /app/data && chown -R app:app /app
USER app

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]