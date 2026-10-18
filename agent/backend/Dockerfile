FROM node:22-slim
WORKDIR /app

COPY mcp-ryhti/package*.json ./mcp-ryhti/
RUN cd mcp-ryhti && npm ci
COPY mcp-mml/package*.json ./mcp-mml/
RUN cd mcp-mml && npm ci
COPY mcp-helsinki-decisions/package*.json ./mcp-helsinki-decisions/
RUN cd mcp-helsinki-decisions && npm ci
COPY mcp-articles/package*.json ./mcp-articles/
RUN cd mcp-articles && npm ci
COPY mcp-risk/package*.json ./mcp-risk/
RUN cd mcp-risk && npm ci
COPY backend/package*.json ./backend/
RUN cd backend && npm ci

COPY backend ./backend
COPY mcp-ryhti ./mcp-ryhti
COPY mcp-mml ./mcp-mml
COPY mcp-helsinki-decisions ./mcp-helsinki-decisions
COPY mcp-articles ./mcp-articles
COPY mcp-risk ./mcp-risk
COPY bbox_parcels.json ./data/bbox_parcels.json
COPY parcels_with_normalized_risks.json ./data/parcels_with_normalized_risks.json


WORKDIR /app/backend
CMD ["npx", "tsx", "src/index.ts"]
