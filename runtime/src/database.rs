use crate::ApiError;
use chrono::{SecondsFormat, Utc};
use rusqlite::{
    params_from_iter,
    types::{Value as SqlValue, ValueRef},
    Connection,
};
use serde_json::{json, Map, Value};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    path::Path,
};

mod auto_completion;
mod claims;
mod comments;
mod conversations;
mod jira;
mod projects;
mod rows;
mod schema;
mod sync;
mod tasks;
#[cfg(test)]
mod tests;

pub struct Database {
    connection: Connection,
    jira_pause_resolutions: RefCell<HashMap<String, Value>>,
    jira_reopen_actions: RefCell<HashMap<String, Value>>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, ApiError> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let database = Self {
            connection: Connection::open(path)?,
            jira_pause_resolutions: RefCell::new(HashMap::new()),
            jira_reopen_actions: RefCell::new(HashMap::new()),
        };
        database.connection.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
        )?;
        database.migrate()?;
        database.interrupt_abandoned_ai_chat_runs()?;
        Ok(database)
    }

    pub fn call(&mut self, method: &str, args: &[Value]) -> Result<Value, ApiError> {
        if let Some(result) = self.call_projects(method, args) {
            return result;
        }
        if let Some(result) = self.call_tasks(method, args) {
            return result;
        }
        if let Some(result) = self.call_conversations(method, args) {
            return result;
        }
        if let Some(result) = self.call_comments(method, args) {
            return result;
        }
        if let Some(result) = self.call_jira(method, args) {
            return result;
        }
        if let Some(result) = self.call_claims(method, args) {
            return result;
        }
        if method == "syncJiraTasks" {
            return self.sync_jira_tasks(&arg(args, 0), &arg(args, 1));
        }
        if let Some(result) = self.call_auto_completion(method, args) {
            return result;
        }
        Err(ApiError::new(
            501,
            "DATABASE_METHOD_NOT_IMPLEMENTED",
            format!("Database method '{method}' has not been migrated"),
        ))
    }

    fn all(&self, sql: &str, parameters: &[Value]) -> Result<Vec<Value>, ApiError> {
        let parameters: Vec<SqlValue> = parameters.iter().map(sql_value).collect();
        let mut statement = self.connection.prepare(sql)?;
        let names: Vec<String> = statement
            .column_names()
            .iter()
            .map(|s| s.to_string())
            .collect();
        let records = statement
            .query_map(params_from_iter(parameters), |row| {
                let mut object = Map::new();
                for (index, name) in names.iter().enumerate() {
                    let value = match row.get_ref(index)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(n) => json!(n),
                        ValueRef::Text(s) => Value::String(String::from_utf8_lossy(s).into_owned()),
                        ValueRef::Blob(s) => Value::Array(s.iter().map(|n| json!(n)).collect()),
                    };
                    object.insert(name.clone(), value);
                }
                Ok(Value::Object(object))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    }

    fn get(&self, sql: &str, parameters: &[Value]) -> Result<Value, ApiError> {
        Ok(self
            .all(sql, parameters)?
            .into_iter()
            .next()
            .unwrap_or(Value::Null))
    }

    fn run(&self, sql: &str, parameters: &[Value]) -> Result<usize, ApiError> {
        let parameters: Vec<SqlValue> = parameters.iter().map(sql_value).collect();
        Ok(self.connection.execute(sql, params_from_iter(parameters))?)
    }

    fn batch(&self, sql: &str) -> Result<(), ApiError> {
        self.connection.execute_batch(sql)?;
        Ok(())
    }

    fn transaction<T>(
        &self,
        operation: impl FnOnce() -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        // 顶层先取得写锁，避免编号和版本校验被并发写入插队；嵌套操作使用保存点。
        if self.connection.is_autocommit() {
            self.batch("BEGIN IMMEDIATE")?;
            return match operation() {
                Ok(value) => match self.batch("COMMIT") {
                    Ok(()) => Ok(value),
                    Err(error) => {
                        let _ = self.batch("ROLLBACK");
                        Err(error)
                    }
                },
                Err(error) => {
                    let _ = self.batch("ROLLBACK");
                    Err(error)
                }
            };
        }
        let savepoint = format!("panel_{}", uuid::Uuid::new_v4().simple());
        self.batch(&format!("SAVEPOINT {savepoint}"))?;
        match operation() {
            Ok(value) => match self.batch(&format!("RELEASE {savepoint}")) {
                Ok(()) => Ok(value),
                Err(error) => {
                    let _ = self.batch(&format!("ROLLBACK TO {savepoint}; RELEASE {savepoint}"));
                    Err(error)
                }
            },
            Err(error) => {
                let _ = self.batch(&format!("ROLLBACK TO {savepoint}; RELEASE {savepoint}"));
                Err(error)
            }
        }
    }
}

fn sql_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => n
            .as_i64()
            .map(SqlValue::Integer)
            .unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or_default())),
        Value::String(s) => SqlValue::Text(s.clone()),
        _ => SqlValue::Text(value.to_string()),
    }
}

fn now() -> Value {
    json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
}
fn id() -> Value {
    json!(uuid::Uuid::new_v4().to_string())
}
fn arg(args: &[Value], n: usize) -> Value {
    args.get(n).cloned().unwrap_or(Value::Null)
}
fn optional(args: &[Value], n: usize) -> Option<&Value> {
    args.get(n)
        .filter(|v| v.get("$panelUndefined") != Some(&Value::Bool(true)))
}
fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
fn truth(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().unwrap_or_default() != 0.0,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn fallback(value: &Value, default: Value) -> Value {
    if value.is_null() {
        default
    } else {
        value.clone()
    }
}
fn same(left: &Value, right: &Value) -> bool {
    // SQLite REAL 与 JSON 整数在 JavaScript 中都是 Number，不能因存储类型不同触发版本变更。
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).map(|b| same(a, b)).unwrap_or(false))
        }
        _ => left == right,
    }
}
fn array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}
fn parse_json(value: &Value) -> Result<Value, ApiError> {
    if value.is_null() {
        Ok(Value::Null)
    } else {
        Ok(serde_json::from_str(text(value))?)
    }
}
fn json_text(value: &Value) -> Value {
    if value.is_null() {
        Value::Null
    } else {
        json!(value.to_string())
    }
}
fn fields(row: &Value, names: &str) -> Value {
    let mut result = Map::new();
    for name in names.split_whitespace() {
        let mut parts = name.split(':');
        let source = parts.next().unwrap();
        let destination = parts
            .next()
            .map(str::to_owned)
            .unwrap_or_else(|| camel(source));
        result.insert(destination, row[source].clone());
    }
    Value::Object(result)
}
fn camel(value: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for c in value.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}
fn missing(kind: &str, value: &Value) -> ApiError {
    ApiError::new(
        404,
        format!("{}_NOT_FOUND", kind.to_uppercase()),
        format!("{kind} '{}' does not exist", text(value)),
    )
}
fn version(record: &Value, expected: &Value, kind: &str) -> Result<(), ApiError> {
    if record["version"] != *expected {
        return Err(ApiError::new(
            409,
            "VERSION_CONFLICT",
            format!("{kind} was changed by another client"),
        )
        .with_details(json!({"expectedVersion":expected,"actualVersion":record["version"]})));
    }
    Ok(())
}
