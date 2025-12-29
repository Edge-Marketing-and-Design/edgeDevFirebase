import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { EdgeFirebase } from "../../edgeFirebase";
import { createTools } from "./tools.js";

type FirebaseConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
  emulatorAuth?: string;
  emulatorFirestore?: string;
  emulatorFunctions?: string;
  emulatorStorage?: string;
};

type EdgeFirebaseState = {
  instance: EdgeFirebase | null;
  error: string | null;
};

const parseBoolean = (value: string | undefined): boolean =>
  value === "true" || value === "1";

const loadConfigFromEnv = (): FirebaseConfig => {
  const jsonConfig = process.env.EDGEFIREBASE_CONFIG_JSON;
  if (jsonConfig) {
    try {
      return JSON.parse(jsonConfig) as FirebaseConfig;
    } catch (error) {
      throw new Error(
        `Invalid EDGEFIREBASE_CONFIG_JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    apiKey: process.env.EDGEFIREBASE_API_KEY ?? "",
    authDomain: process.env.EDGEFIREBASE_AUTH_DOMAIN ?? "",
    projectId: process.env.EDGEFIREBASE_PROJECT_ID ?? "",
    storageBucket: process.env.EDGEFIREBASE_STORAGE_BUCKET ?? "",
    messagingSenderId: process.env.EDGEFIREBASE_MESSAGING_SENDER_ID ?? "",
    appId: process.env.EDGEFIREBASE_APP_ID ?? "",
    measurementId: process.env.EDGEFIREBASE_MEASUREMENT_ID ?? "",
    emulatorAuth: process.env.EDGEFIREBASE_EMULATOR_AUTH ?? "",
    emulatorFirestore: process.env.EDGEFIREBASE_EMULATOR_FIRESTORE ?? "",
    emulatorFunctions: process.env.EDGEFIREBASE_EMULATOR_FUNCTIONS ?? "",
    emulatorStorage: process.env.EDGEFIREBASE_EMULATOR_STORAGE ?? "",
  };
};

const hasConfig = (config: FirebaseConfig): boolean =>
  Object.values(config).some((value) => Boolean(value));

const buildEdgeFirebase = (): EdgeFirebase => {
  const config = loadConfigFromEnv();
  if (!hasConfig(config)) {
    throw new Error(
      "Missing EdgeFirebase configuration. Set EDGEFIREBASE_CONFIG_JSON or the EDGEFIREBASE_* env vars."
    );
  }
  const isPersistent = parseBoolean(process.env.EDGEFIREBASE_PERSISTENT);
  const enablePopupRedirect = parseBoolean(
    process.env.EDGEFIREBASE_ENABLE_POPUP_REDIRECT
  );
  const functionsRegion =
    process.env.EDGEFIREBASE_FUNCTIONS_REGION ?? "us-central1";

  return new EdgeFirebase(
    config,
    isPersistent,
    enablePopupRedirect,
    functionsRegion
  );
};

const edgeFirebaseState: EdgeFirebaseState = {
  instance: null,
  error: null,
};

const getEdgeFirebase = (): EdgeFirebase => {
  if (edgeFirebaseState.instance) {
    return edgeFirebaseState.instance;
  }
  if (edgeFirebaseState.error) {
    throw new Error(edgeFirebaseState.error);
  }

  try {
    edgeFirebaseState.instance = buildEdgeFirebase();
  } catch (error) {
    edgeFirebaseState.error =
      error instanceof Error ? error.message : String(error);
    throw error;
  }

  return edgeFirebaseState.instance;
};

const toPlain = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
};

const main = async () => {
  const staticSearchStore = new Map<string, unknown>();
  const tools = createTools(getEdgeFirebase, staticSearchStore);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(
    {
      name: "mcp-edgefirebase",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${request.params.name}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(toPlain(result), null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  console.error("Failed to start mcp-edgefirebase:", error);
  process.exit(1);
});
