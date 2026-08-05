FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.js web-server.js twitch-oauth.js token-store.js channel-store.js \
     commands.js rate-limiter.js neural-nexus.js ./

# The token store is a bind mount from the host. Create it up front owned by the
# unprivileged runtime user so the refresh token can be rewritten on rotation.
RUN mkdir -p /app/.twitch-tokens && chown -R node:node /app

ENV NODE_ENV=production
ENV OAUTH_PORT=9070
ENV OAUTH_REDIRECT_URI=http://localhost:9070
ENV ENV_PATH=/app/.env
ENV TOKEN_STORE_PATH=/app/.twitch-tokens/tokens.json
ENV CHANNEL_STORE_PATH=/app/.twitch-tokens/channels.json

USER node

EXPOSE 9070

CMD ["node", "bot.js"]
