// OpenAPI 3.1 description of the public API (v1), served at /api/v1/openapi.json.
const error = { type: "object", properties: { error: { type: "string" } }, required: ["error"] };
const errors = Object.fromEntries(
  [["400", "Invalid input"], ["401", "Missing or invalid bot token"], ["403", "Missing permission"], ["404", "Not found (also for things the bot can't see)"], ["429", "Rate limited"]]
    .map(([code, description]) => [code, { description, content: { "application/json": { schema: error } } }]),
);
const message = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    channelId: { type: "string", format: "uuid" },
    authorId: { type: "string" },
    authorName: { type: "string" },
    authorBot: { type: "boolean" },
    content: { type: "string", description: "Markdown subset; mentions as <@userId>" },
    createdAt: { type: "string", format: "date-time" },
    editedAt: { type: ["string", "null"], format: "date-time" },
    threadId: { type: ["string", "null"], format: "uuid" },
    replyTo: { type: ["object", "null"] },
    reactions: { type: "array", items: { type: "object", properties: { emoji: { type: "string" }, userIds: { type: "array", items: { type: "string" } } } } },
    pinned: { type: "boolean" },
  },
};

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "openDiscord API",
    version: "1",
    description:
      "For bots created in a community's settings. Authenticate with `Authorization: Bot <token>`. A bot is a member: its roles and channel permissions decide what it can read and send. 60 requests per minute per bot, plus the normal message rate limit.",
  },
  servers: [{ url: "/api/v1" }],
  components: { securitySchemes: { bot: { type: "apiKey", in: "header", name: "Authorization", description: "Bot <token>" } } },
  security: [{ bot: [] }],
  paths: {
    "/me": {
      get: {
        summary: "The bot behind the token",
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } } } }, ...errors },
      },
    },
    "/communities/{communityId}/channels": {
      get: {
        summary: "Channels the bot can view",
        parameters: [{ name: "communityId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "200": { description: "OK" }, ...errors },
      },
    },
    "/channels/{channelId}/messages": {
      get: {
        summary: "A page of messages, oldest first",
        parameters: [
          { name: "channelId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "before", in: "query", schema: { type: "string", format: "uuid" }, description: "Message id: return the page before it" },
          { name: "thread", in: "query", schema: { type: "string", format: "uuid" }, description: "Thread root id: return that thread" },
        ],
        responses: {
          "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { messages: { type: "array", items: message }, hasMore: { type: "boolean" } } } } } },
          ...errors,
        },
      },
      post: {
        summary: "Send a message",
        parameters: [{ name: "channelId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["content"], properties: { content: { type: "string", maxLength: 4000 }, replyToId: { type: "string", format: "uuid" }, threadId: { type: "string", format: "uuid" } } } } },
        },
        responses: { "201": { description: "Created", content: { "application/json": { schema: message } } }, ...errors },
      },
    },
  },
} as const;
