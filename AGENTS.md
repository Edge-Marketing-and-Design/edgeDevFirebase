# AGENTS.md instructions

When giving implementation advice, include a short concrete code example (and before/after when useful).

## Versioning

- When bumping this package version, use `YY.month.patch`.
- Use the current calendar month as the middle number, without a leading zero.
- If the current package version is from an earlier month, reset the patch number to `1`.
- If the current package version is already in the current month, increment only the patch number.

Example:

```json
{
  "version": "26.6.1"
}
```

## Dev Server Etiquette

- Before starting a dev server, check whether one is already running.
- Do not start a duplicate server on port 3000 if the user already has one.
- Stop any dev server Codex starts before ending the task unless asked to leave it running.

Do not run builds unless I give permission.
