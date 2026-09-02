ALTER TABLE projects
  ADD COLUMN issue_key TEXT;

CREATE UNIQUE INDEX projects_issue_key_unique
  ON projects(issue_key);
