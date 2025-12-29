import type { EdgeFirebase } from "../../edgeFirebase";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  additionalProperties?: boolean;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

type GetEdgeFirebase = () => EdgeFirebase;

type StaticSearchStore = Map<string, unknown>;

const roleSchema: JsonSchema = {
  type: "string",
  enum: ["admin", "editor", "writer", "user"],
};

const permissionsSchema: JsonSchema = {
  type: "object",
  properties: {
    assign: { type: "boolean" },
    read: { type: "boolean" },
    write: { type: "boolean" },
    delete: { type: "boolean" },
  },
  required: ["assign", "read", "write", "delete"],
  additionalProperties: false,
};

const firestoreQuerySchema: JsonSchema = {
  type: "object",
  properties: {
    field: { type: "string" },
    operator: {
      type: "string",
      enum: ["==", "<", "<=", ">", ">=", "array-contains", "in", "array-contains-any"],
    },
    value: {},
  },
  required: ["field", "operator", "value"],
  additionalProperties: false,
};

const firestoreOrderSchema: JsonSchema = {
  type: "object",
  properties: {
    field: { type: "string" },
    direction: { type: "string", enum: ["asc", "desc"] },
  },
  required: ["field", "direction"],
  additionalProperties: false,
};

const userRegisterSchema: JsonSchema = {
  type: "object",
  properties: {
    email: { type: "string" },
    password: { type: "string" },
    meta: { type: "object", additionalProperties: true },
    registrationCode: { type: "string" },
    dynamicDocumentFieldValue: { type: "string" },
    token: { type: "string" },
    identifier: { type: "string" },
    phoneCode: { type: "string" },
    phoneNumber: { type: "string" },
    requestedOrgId: { type: "string" },
  },
  required: ["registrationCode", "meta"],
  additionalProperties: false,
};

const currentUserRegisterSchema: JsonSchema = {
  type: "object",
  properties: {
    registrationCode: { type: "string" },
    dynamicDocumentFieldValue: { type: "string" },
  },
  required: ["registrationCode"],
  additionalProperties: false,
};

const roleAssignmentSchema: JsonSchema = {
  type: "object",
  properties: {
    collectionPath: { type: "string" },
    role: roleSchema,
  },
  required: ["collectionPath", "role"],
  additionalProperties: false,
};

const specialPermissionSchema: JsonSchema = {
  type: "object",
  properties: {
    collectionPath: { type: "string" },
    permissions: permissionsSchema,
  },
  required: ["collectionPath", "permissions"],
  additionalProperties: false,
};

const newUserSchema: JsonSchema = {
  type: "object",
  properties: {
    roles: { type: "array", items: roleAssignmentSchema },
    specialPermissions: { type: "array", items: specialPermissionSchema },
    meta: { type: "object", additionalProperties: true },
    isTemplate: { type: "boolean" },
    customRegCode: { type: "string" },
    subCreate: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        role: roleSchema,
        dynamicDocumentFieldValue: { type: "string" },
        documentStructure: { type: "object", additionalProperties: true },
      },
      required: ["rootPath", "role", "dynamicDocumentFieldValue", "documentStructure"],
      additionalProperties: false,
    },
  },
  required: ["roles", "specialPermissions", "meta"],
  additionalProperties: false,
};

export const createTools = (
  getEdgeFirebase: GetEdgeFirebase,
  staticSearchStore: StaticSearchStore
): ToolDefinition[] => {
  let searchCounter = 0;

  const createSearchId = (): string => {
    searchCounter += 1;
    return `search_${Date.now()}_${searchCounter}`;
  };

  const getSearch = (searchId: string) => {
    const search = staticSearchStore.get(searchId);
    if (!search) {
      throw new Error(`Unknown searchId: ${searchId}`);
    }
    return search as {
      results: Record<string, unknown>;
      getData: (
        collectionPath: string,
        queryList?: unknown[],
        orderList?: unknown[],
        max?: number
      ) => Promise<unknown>;
      next: () => Promise<void>;
      prev: () => Promise<void>;
    };
  };

  return [
    {
      name: "edgefirebase.run_function",
      description: "Run a Firebase callable function using EdgeFirebase.runFunction.",
      inputSchema: {
        type: "object",
        properties: {
          functionName: { type: "string" },
          data: { type: "object", additionalProperties: true },
        },
        required: ["functionName"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        const functionName = args.functionName as string;
        const data = (args.data as Record<string, unknown>) ?? {};
        const result = await edgeFirebase.runFunction(functionName, data);
        return { data: result?.data ?? result };
      },
    },
    {
      name: "edgefirebase.update_email",
      description: "Update the current user's email using EdgeFirebase.updateEmail.",
      inputSchema: {
        type: "object",
        properties: {
          newEmail: { type: "string" },
        },
        required: ["newEmail"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.updateEmail(args.newEmail as string);
      },
    },
    {
      name: "edgefirebase.log_in",
      description: "Start an email/password login using EdgeFirebase.logIn.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string" },
          password: { type: "string" },
        },
        required: ["email", "password"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        edgeFirebase.logIn({
          email: args.email as string,
          password: args.password as string,
        });
        return {
          success: true,
          message: "Login started",
          meta: { user: edgeFirebase.user },
        };
      },
    },
    {
      name: "edgefirebase.log_in_with_microsoft",
      description: "Start a Microsoft OAuth login using EdgeFirebase.logInWithMicrosoft.",
      inputSchema: {
        type: "object",
        properties: {
          providerScopes: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        const providerScopes = (args.providerScopes as string[]) ?? [];
        await edgeFirebase.logInWithMicrosoft(providerScopes);
        return {
          success: true,
          message: "Microsoft login started",
          meta: { user: edgeFirebase.user },
        };
      },
    },
    {
      name: "edgefirebase.log_out",
      description: "Log out the current user using EdgeFirebase.logOut.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        const edgeFirebase = getEdgeFirebase();
        edgeFirebase.logOut();
        return {
          success: true,
          message: "Logged out",
          meta: {},
        };
      },
    },
    {
      name: "edgefirebase.send_password_reset",
      description: "Send a password reset email using EdgeFirebase.sendPasswordReset.",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string" },
        },
        required: ["email"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.sendPasswordReset(args.email as string);
      },
    },
    {
      name: "edgefirebase.password_reset",
      description: "Complete a password reset using EdgeFirebase.passwordReset.",
      inputSchema: {
        type: "object",
        properties: {
          newPassword: { type: "string" },
          passwordResetCode: { type: "string" },
        },
        required: ["newPassword", "passwordResetCode"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.passwordReset(
          args.newPassword as string,
          args.passwordResetCode as string
        );
      },
    },
    {
      name: "edgefirebase.set_password",
      description: "Change the current user's password using EdgeFirebase.setPassword.",
      inputSchema: {
        type: "object",
        properties: {
          oldPassword: { type: "string" },
          newPassword: { type: "string" },
        },
        required: ["oldPassword", "newPassword"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.setPassword(
          args.oldPassword as string,
          args.newPassword as string
        );
      },
    },
    {
      name: "edgefirebase.set_user_meta",
      description: "Update a user's meta fields using EdgeFirebase.setUserMeta.",
      inputSchema: {
        type: "object",
        properties: {
          meta: { type: "object", additionalProperties: true },
          userId: { type: "string" },
          stagedDocId: { type: "string" },
        },
        required: ["meta"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.setUserMeta(
          args.meta as Record<string, unknown>,
          (args.userId as string) ?? "",
          (args.stagedDocId as string) ?? ""
        );
      },
    },
    {
      name: "edgefirebase.add_user",
      description: "Add a user using EdgeFirebase.addUser.",
      inputSchema: {
        type: "object",
        properties: {
          newUser: newUserSchema,
        },
        required: ["newUser"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.addUser(args.newUser as Record<string, unknown>);
      },
    },
    {
      name: "edgefirebase.register_user",
      description: "Register a new user using EdgeFirebase.registerUser.",
      inputSchema: {
        type: "object",
        properties: {
          userRegister: userRegisterSchema,
          authProvider: {
            type: "string",
            enum: [
              "email",
              "microsoft",
              "google",
              "facebook",
              "github",
              "twitter",
              "apple",
              "phone",
              "emailLink",
              "customToken",
            ],
          },
          providerScopes: { type: "array", items: { type: "string" } },
        },
        required: ["userRegister"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.registerUser(
          args.userRegister as Record<string, unknown>,
          (args.authProvider as string) ?? "email",
          (args.providerScopes as string[]) ?? []
        );
      },
    },
    {
      name: "edgefirebase.current_user_register",
      description: "Invite the current user into a new org using EdgeFirebase.currentUserRegister.",
      inputSchema: {
        type: "object",
        properties: {
          userRegister: currentUserRegisterSchema,
        },
        required: ["userRegister"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.currentUserRegister(
          args.userRegister as Record<string, unknown>
        );
      },
    },
    {
      name: "edgefirebase.remove_user",
      description: "Remove a user using EdgeFirebase.removeUser.",
      inputSchema: {
        type: "object",
        properties: {
          docId: { type: "string" },
        },
        required: ["docId"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.removeUser(args.docId as string);
      },
    },
    {
      name: "edgefirebase.delete_self",
      description: "Delete the current user using EdgeFirebase.deleteSelf.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.deleteSelf();
      },
    },
    {
      name: "edgefirebase.store_collection_permissions",
      description: "Store role permissions for a collection using EdgeFirebase.storeCollectionPermissions.",
      inputSchema: {
        type: "object",
        properties: {
          collectionPath: { type: "string" },
          role: roleSchema,
          permissions: permissionsSchema,
        },
        required: ["collectionPath", "role", "permissions"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.storeCollectionPermissions(
          args.collectionPath as string,
          args.role as "admin" | "editor" | "writer" | "user",
          args.permissions as Record<string, boolean>
        );
      },
    },
    {
      name: "edgefirebase.remove_collection_permissions",
      description: "Remove role permissions for a collection using EdgeFirebase.removeCollectionPermissions.",
      inputSchema: {
        type: "object",
        properties: {
          collectionPath: { type: "string" },
        },
        required: ["collectionPath"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.removeCollectionPermissions(args.collectionPath as string);
      },
    },
    {
      name: "edgefirebase.store_user_roles",
      description: "Assign a role to a user using EdgeFirebase.storeUserRoles.",
      inputSchema: {
        type: "object",
        properties: {
          docId: { type: "string" },
          collectionPath: { type: "string" },
          role: roleSchema,
        },
        required: ["docId", "collectionPath", "role"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        const edgeFirebaseAny = edgeFirebase as EdgeFirebase & {
          storeUserRoles?: (
            docId: string,
            collectionPath: string,
            role: "admin" | "editor" | "writer" | "user"
          ) => Promise<unknown>;
        };
        if (!edgeFirebaseAny.storeUserRoles) {
          throw new Error("storeUserRoles is not available on this EdgeFirebase build.");
        }
        return edgeFirebaseAny.storeUserRoles(
          args.docId as string,
          args.collectionPath as string,
          args.role as "admin" | "editor" | "writer" | "user"
        );
      },
    },
    {
      name: "edgefirebase.remove_user_roles",
      description: "Remove a user's role assignment using EdgeFirebase.removeUserRoles.",
      inputSchema: {
        type: "object",
        properties: {
          docId: { type: "string" },
          collectionPath: { type: "string" },
        },
        required: ["docId", "collectionPath"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.removeUserRoles(
          args.docId as string,
          args.collectionPath as string
        );
      },
    },
    {
      name: "edgefirebase.store_user_special_permissions",
      description: "Store special permissions for a user using EdgeFirebase.storeUserSpecialPermissions.",
      inputSchema: {
        type: "object",
        properties: {
          docId: { type: "string" },
          collectionPath: { type: "string" },
          permissions: permissionsSchema,
        },
        required: ["docId", "collectionPath", "permissions"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.storeUserSpecialPermissions(
          args.docId as string,
          args.collectionPath as string,
          args.permissions as Record<string, boolean>
        );
      },
    },
    {
      name: "edgefirebase.remove_user_special_permissions",
      description: "Remove special permissions from a user using EdgeFirebase.removeUserSpecialPermissions.",
      inputSchema: {
        type: "object",
        properties: {
          docId: { type: "string" },
          collectionPath: { type: "string" },
        },
        required: ["docId", "collectionPath"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.removeUserSpecialPermissions(
          args.docId as string,
          args.collectionPath as string
        );
      },
    },
    {
      name: "edgefirebase.start_users_snapshot",
      description: "Start the users snapshot listener using EdgeFirebase.startUsersSnapshot.",
      inputSchema: {
        type: "object",
        properties: {
          collectionPath: { type: "string" },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        await edgeFirebase.startUsersSnapshot(
          (args.collectionPath as string) ?? ""
        );
        return {
          success: true,
          message: "startUsersSnapshot started",
          meta: {},
        };
      },
    },
    {
      name: "edgefirebase.start_snapshot",
      description: "Start a collection snapshot listener using EdgeFirebase.startSnapshot.",
      inputSchema: {
        type: "object",
        properties: {
          collectionPath: { type: "string" },
          queryList: { type: "array", items: firestoreQuerySchema },
          orderList: { type: "array", items: firestoreOrderSchema },
          max: { type: "number" },
        },
        required: ["collectionPath"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.startSnapshot(
          args.collectionPath as string,
          (args.queryList as unknown[]) ?? [],
          (args.orderList as unknown[]) ?? [],
          (args.max as number) ?? 0
        );
      },
    },
    {
      name: "edgefirebase.start_document_snapshot",
      description: "Start a document snapshot listener using EdgeFirebase.startDocumentSnapshot.",
      inputSchema: {
        type: "object",
        properties: {
          collectionPath: { type: "string" },
          docId: { type: "string" },
        },
        required: ["collectionPath", "docId"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.startDocumentSnapshot(
          args.collectionPath as string,
          args.docId as string
        );
      },
    },
    {
      name: "edgefirebase.stop_snapshot",
      description: "Stop a snapshot listener using EdgeFirebase.stopSnapshot.",
      inputSchema: {
        type: "object",
        properties: {
          collectionPath: { type: "string" },
        },
        required: ["collectionPath"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        edgeFirebase.stopSnapshot(args.collectionPath as string);
        return {
          success: true,
          message: "stopSnapshot called",
          meta: {},
        };
      },
    },
    {
      name: "edgefirebase.store_doc",
      description: "Add or update a document using EdgeFirebase.storeDoc.",
      inputSchema: {
        type: "object",
        properties: {
          collectionPath: { type: "string" },
          item: { type: "object", additionalProperties: true },
        },
        required: ["collectionPath", "item"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.storeDoc(
          args.collectionPath as string,
          args.item as Record<string, unknown>
        );
      },
    },
    {
      name: "edgefirebase.change_doc",
      description: "Update document fields using EdgeFirebase.changeDoc.",
      inputSchema: {
        type: "object",
        properties: {
          collectionPath: { type: "string" },
          docId: { type: "string" },
          item: { type: "object", additionalProperties: true },
        },
        required: ["collectionPath", "docId", "item"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.changeDoc(
          args.collectionPath as string,
          args.docId as string,
          args.item as Record<string, unknown>
        );
      },
    },
    {
      name: "edgefirebase.get_doc_data",
      description: "Fetch a single document using EdgeFirebase.getDocData.",
      inputSchema: {
        type: "object",
        properties: {
          collectionPath: { type: "string" },
          docId: { type: "string" },
        },
        required: ["collectionPath", "docId"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.getDocData(
          args.collectionPath as string,
          args.docId as string
        );
      },
    },
    {
      name: "edgefirebase.remove_doc",
      description: "Delete a document using EdgeFirebase.removeDoc.",
      inputSchema: {
        type: "object",
        properties: {
          collectionPath: { type: "string" },
          docId: { type: "string" },
        },
        required: ["collectionPath", "docId"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        return edgeFirebase.removeDoc(
          args.collectionPath as string,
          args.docId as string
        );
      },
    },
    {
      name: "edgefirebase.static_search_start",
      description: "Create a static search session using EdgeFirebase.SearchStaticData.getData.",
      inputSchema: {
        type: "object",
        properties: {
          collectionPath: { type: "string" },
          queryList: { type: "array", items: firestoreQuerySchema },
          orderList: { type: "array", items: firestoreOrderSchema },
          max: { type: "number" },
        },
        required: ["collectionPath"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const edgeFirebase = getEdgeFirebase();
        const SearchStaticData = edgeFirebase.SearchStaticData;
        const search = new SearchStaticData();
        await search.getData(
          args.collectionPath as string,
          (args.queryList as unknown[]) ?? [],
          (args.orderList as unknown[]) ?? [],
          (args.max as number) ?? 0
        );
        const searchId = createSearchId();
        staticSearchStore.set(searchId, search);
        return {
          searchId,
          results: search.results,
        };
      },
    },
    {
      name: "edgefirebase.static_search_next",
      description: "Advance to the next static search page.",
      inputSchema: {
        type: "object",
        properties: {
          searchId: { type: "string" },
        },
        required: ["searchId"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const search = getSearch(args.searchId as string);
        await search.next();
        return { searchId: args.searchId, results: search.results };
      },
    },
    {
      name: "edgefirebase.static_search_prev",
      description: "Move to the previous static search page.",
      inputSchema: {
        type: "object",
        properties: {
          searchId: { type: "string" },
        },
        required: ["searchId"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const search = getSearch(args.searchId as string);
        await search.prev();
        return { searchId: args.searchId, results: search.results };
      },
    },
    {
      name: "edgefirebase.static_search_results",
      description: "Get the current results for a static search session.",
      inputSchema: {
        type: "object",
        properties: {
          searchId: { type: "string" },
        },
        required: ["searchId"],
        additionalProperties: false,
      },
      handler: async (args) => {
        const search = getSearch(args.searchId as string);
        return { searchId: args.searchId, results: search.results };
      },
    },
    {
      name: "edgefirebase.static_search_dispose",
      description: "Dispose of a static search session.",
      inputSchema: {
        type: "object",
        properties: {
          searchId: { type: "string" },
        },
        required: ["searchId"],
        additionalProperties: false,
      },
      handler: async (args) => {
        staticSearchStore.delete(args.searchId as string);
        return {
          success: true,
          message: "static search disposed",
          meta: { searchId: args.searchId },
        };
      },
    },
  ];
};
