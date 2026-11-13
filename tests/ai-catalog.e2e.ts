import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The e2e server points the Codex executable at a nonexistent path, which is
// the same spawn ENOENT a machine without the Codex CLI produces. The
// optional AI catalog must degrade to HTTP 200 with an unavailable payload,
// not a 500 on every fresh page load.
test('GET /api/local/ai/catalog returns an unavailable catalog without Codex', async ({ app }) => {
  const response = await fetch(new URL('/api/local/ai/catalog?projectId=local', app.baseUrl));
  expect(response.status).toBe(200);
  const catalog = await response.json() as {
    available: boolean;
    models: unknown[];
    skills: unknown[];
    sandboxes: string[];
  };
  expect(catalog.available).toBe(false);
  expect(catalog.models).toEqual([]);
  expect(catalog.skills).toEqual([]);
  expect(catalog.sandboxes).toEqual(['read-only', 'workspace-write', 'danger-full-access']);
});
