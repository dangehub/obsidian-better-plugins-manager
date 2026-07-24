---
title: plugin-notes-export eval scenarios
scenarios:
  - name: codec-tests
    tags: [frontend-e2e]
    description: frontmatter codec pure function tests pass
    expected: npm test exit 0, 30 tests pass
  - name: build
    tags: [cli]
    description: TypeScript compilation succeeds
    expected: npm run build exit 0, no errors
  - name: safety
    tags: [desktop, mobile]
    description: directory isolation, no-overwrite, path validation via mock Vault/Adapter tests
    expected: all 30 tests pass including unowned/malformed/duplicate/traversal cases
---
