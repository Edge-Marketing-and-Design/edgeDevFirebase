Codex Agent Guidelines for edgeDevFirebase

This document defines the rules, conventions, and expectations that Codex must follow when scanning the edgeDevFirebase repository and generating Model–Composition Protocol (MCP) tools or other code. The goal of these guidelines is to ensure that any generated code aligns with our architecture, multi‑tenant data model, security rules, and developer experience.

1. Project Overview

Repository: Edge-Marketing-and-Design/edgeDevFirebase (branch: MPC)

Frameworks & Tools: Vue 3, Nuxt 3 (Composition API), TypeScript, Tailwind, ShadCN components, Firebase (Auth, Firestore, Functions), Cloudflare (Images, R2, Streaming, KV, Zones) and our own wrappers (edgeFirebase.ts and related modules).

Architecture: Multi‑tenant SaaS platform with per‑tenant data isolation. Each tenant lives under its own Firestore collection/document path, and roles/permissions (admin/editor/writer/user) are applied per collection. Special permissions may override role defaults. A staged-users collection acts as a staging area for user registration and role assignment.

Scaffolding CLI: The repository contains a starter CLI that automates environment setup, emulator configuration, and installs boilerplate dashboards, CMS, Stripe integration, printing functionality, pre‑built component packages, Cloudflare wrappers, and default multi‑tenant structure.

1. Directory Conventions

Packages and Utilities: All Firebase and Cloudflare interactions must go through our wrappers in src/edgeFirebase.ts and related files. Do not import from firebase/*, @firebase/… or @google-cloud/* directly in generated code.

Composables and Plugins: Nuxt composables are located under src/composables/. Client‑only plugins live in src/plugins/ with a .client.ts suffix.

Server Functions (Nitro): Server routes and RPC endpoints live in the src/server/ directory. Use the Nuxt Nitro pattern: server/api/<resource>.<method>.ts.

Tooling: Place any generated MCP server and tool registry under tools/mcp-edgefirebase/. Within this directory, include:

package.json and tsconfig.json

src/index.ts (entry point for the MCP server)

src/tools.ts or similar (exports each MCP tool)

README.md (documentation for the tools)

Example configuration snippets (see Section 6).

1. Import and Naming Rules

Use our wrappers: Always call edgeFirebase methods (or other helper classes) instead of raw SDK calls. For example, use edgeFirebase.addUser() instead of firebase.firestore().collection('…').add().

Avoid direct Firebase imports: Imports such as import { getAuth } from 'firebase/auth' are forbidden. If a needed wrapper does not exist, update the wrappers instead of bypassing them.

Tenant awareness: Any code that accesses Firestore or Auth must accept a tenantId or collectionPath parameter. Do not hard‑code collection paths; instead, use parameters or environment variables to reference the correct tenant.

Permission checks: Always perform role/special‑permission checks via our Rule Helpers before reading/writing data. Do not write data without verifying that the user has the appropriate permissions.

Naming conventions:

Functions should be in camelCase and clearly describe the action (storeDoc, startSnapshot).

Classes and interfaces should be in PascalCase (EdgeFirebase, Permissions).

Variables representing collections should end in CollectionPath or Path for clarity.

1. Exposing MCP Tools

Codex should expose only the stable, high‑level functions as MCP tools. Do not expose internal helpers or functions that bypass our permission model.

4.1 Core Tools

Expose the following functions as individual MCP tools (each with well‑typed inputs and outputs):

Tool Name  Purpose
addUser  Add a new user to the staged-users collection with roles and meta data.
registerUser  Register a staged user with email/password (or Microsoft provider).
currentUserRegister  Invite an existing user to register for a new tenant/org.
logIn  Log in a user with email/password.
logInWithMicrosoft  Log in a user with Microsoft credentials and optional scopes.
logOut  Log the current user out and clean up listeners.
updateEmail  Change the user's email.
setPassword  Change the user's password.
sendPasswordReset  Send a password‑reset email.
passwordReset  Complete a password reset via oobCode.
setUserMeta  Update user meta fields (e.g., firstName, lastName) for the current user.
storeDoc / changeDoc  Add/update a document or partial fields in Firestore (with permission checks).
getDocData / removeDoc  Read or delete a document.
startSnapshot / stopSnapshot  Start or stop a Firestore snapshot listener on a collection or doc.
startUsersSnapshot / stopUsersSnapshot  Listen to changes in users for a given collection.
SearchStaticData  Retrieve static (paginated) data from a collection with query/sort/limit.
runFunction  Invoke a callable Cloud Function with automatic UID injection.
updateRules  Write or update Firestore rules (if scaffolding extends to rules).
4.2 Higher‑Level Scaffolding

Beyond the core tools, Codex may wrap our CLI scaffolds to generate entire feature modules. These high‑level tools must:

Accept descriptive inputs (e.g. collection name, tenant scope, role presets, UI type).

Invoke the internal CLI or scaffolder scripts to generate all files (Nuxt pages, server routes, Firestore collection, rules, tests).

Return a summary of created files and next steps.

Suggested high‑level tool names:

Tool Name  Description
scaffoldFeature  Generate a new multi‑tenant feature with CRUD endpoints, UI pages, and rules.
scaffoldFirestoreCollection  Create a new Firestore collection with default roles and rules.
scaffoldNitroRoute  Add a new server API endpoint using the Nuxt Nitro pattern.
scaffoldUiForm  Generate a form component and schema for a given entity.
scaffoldStripeFlow  Create a Stripe integration flow using our wrappers.
scaffoldPrintTemplate  Generate a printable PDF/HTML template.
5. Permissions and Security

Role Lookups: Use the default role permissions defined in collection-data/-default- unless a more specific collection path exists. Roles are ordered: admin > editor > writer > user
github.com
.

Special Permissions: If a user has special permissions for a collection, they override the role permissions
github.com
.

Root Access: The root collection path '-' denotes global (super‑admin) permissions
github.com
. Tools should only grant or check root access when explicitly requested.

Staged Users: All modifications to user roles and meta must occur in the staged-users collection; direct writes to the users collection are forbidden
github.com
.

Await Promises: Always await asynchronous calls to ensure that rule helpers have time to write RuleCheck objects
github.com
. Failing to await may result in inconsistent permission enforcement.

1. Example MCP Configuration Snippet

To use the generated MCP server in VS Code or with the Codex CLI, add the following to your ~/.codex/config.toml:

[servers.edgeFirebase]
url = "<http://localhost:PORT>"  # Replace with your MCP server port
api_key = "your-auth-token-if-needed"

[tools]
edgeFirebase.addUser = { server = "edgeFirebase" }
edgeFirebase.registerUser = { server = "edgeFirebase" }
edgeFirebase.logIn = { server = "edgeFirebase" }
edgeFirebase.logOut = { server = "edgeFirebase" }
edgeFirebase.storeDoc = { server = "edgeFirebase" }

# ...continue listing each exposed tool


A repository‑local example configuration can be placed at tools/mcp-edgefirebase/example.config.toml for your team to reference.

1. Updating These Guidelines

Whenever you introduce new wrappers, helpers, or scaffolds, update AGENTS.md accordingly. Codex relies on this file to understand how to interact with the repository. If a generated pull request deviates from these rules, refine the instructions here before rerunning the generation.
