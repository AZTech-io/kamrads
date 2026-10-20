FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/app/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright TZ=Australia/Perth
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && rm -rf /root/.npm /var/lib/apt/lists/*
COPY src ./src
COPY public ./public
COPY scripts ./scripts
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings", "src/index.js"]
