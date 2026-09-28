# mneme-memory —— 零依赖 stdio MCP server（Glama 检查用：能启动、能响应
# introspection 即可；无 MNEME_TOKEN 时工具调用会报未配置，属预期状态）。
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY bin/mneme-mcp.mjs ./bin/mneme-mcp.mjs
RUN chmod +x bin/mneme-mcp.mjs

# stdio 传输：stdin 必须保持打开
CMD ["node", "bin/mneme-mcp.mjs"]
