import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_ISSUE_KEY_PATTERN, defaultProjectIssueKey } from "../shared/domain.mjs";

test("project keys accept internal separators and recover the complete historical prefix", () => {
  for (const key of ["TP", "A", "TP-ADMIN", "TP-ADMIN-2", "TP-A-B", "TP.ADMIN", "TP-A.B", "A".repeat(32)]) {
    assert.ok(PROJECT_ISSUE_KEY_PATTERN.test(key), key);
  }
  for (const key of ["", "-TP", "TP-", "TP--ADMIN", "TP_ADMIN", ".TP", "TP.", "TP..A", "TP-.A", "TP.-A", "A".repeat(33)]) {
    assert.equal(PROJECT_ISSUE_KEY_PATTERN.test(key), false, key);
  }
  assert.equal(defaultProjectIssueKey({ id: "other", name: "Other", firstIdentifier: "TP-ADMIN-1" }), "TP-ADMIN");
  assert.equal(defaultProjectIssueKey({ id: "other", name: "Other", firstIdentifier: "TP-ADMIN-2-19" }), "TP-ADMIN-2");
  assert.equal(defaultProjectIssueKey({ id: "other", name: "Other", firstIdentifier: "TP-A.B-19" }), "TP-A.B");
  const longKey = "TP-" + "A".repeat(29);
  assert.equal(defaultProjectIssueKey({ id: "other", name: "Other", firstIdentifier: `${longKey}-1` }), longKey);
});
