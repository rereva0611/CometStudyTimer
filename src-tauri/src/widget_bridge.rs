use serde_json::Value;
pub fn authorize(actual: &str, required: &str) -> Result<(), String> {
    if actual == required {
        Ok(())
    } else {
        Err("This Comet command is unavailable from this window.".into())
    }
}
pub fn validate_action(id: &str, action: &Value) -> Result<(), String> {
    if crate::widget_preferences::valid_request_id(id)
        && action.is_object()
        && action.to_string().len() <= 8192
    {
        Ok(())
    } else {
        Err("Invalid widget request.".into())
    }
}
pub fn validate_controller(payload: &Value) -> Result<(), String> {
    let invalid = || "Invalid controller snapshot.".to_owned();
    if payload.to_string().len() > 32 * 1024 * 1024 || !payload.is_object() {
        return Err(invalid());
    }
    let ready = payload["ready"].as_bool().ok_or_else(invalid)?;
    let error = payload.get("error").ok_or_else(invalid)?;
    if !error.is_null() && error.as_str().is_none_or(|s| s.len() > 4096) {
        return Err(invalid());
    }
    let undo = payload.get("undo").ok_or_else(invalid)?;
    if !undo.is_null() && (!undo.is_object() || undo["expiresAt"].as_u64().is_none()) {
        return Err(invalid());
    }
    let state = payload.get("state").ok_or_else(invalid)?;
    if !state.is_null() {
        crate::storage::validate_state(state)?;
    } else if ready {
        return Err(invalid());
    }
    Ok(())
}
pub fn validate_reply(id: &str, result: &Value) -> Result<(), String> {
    if !crate::widget_preferences::valid_request_id(id) {
        return Err("Invalid widget request ID.".into());
    }
    if result.to_string().len() > 32 * 1024 * 1024 {
        return Err("Widget reply exceeds the payload limit.".into());
    }
    match result["ok"].as_bool() {
        Some(true) => validate_controller(&result["snapshot"]),
        Some(false)
            if result["error"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 4096) =>
        {
            Ok(())
        }
        _ => Err("Invalid widget reply.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn oversized_failure_reply_is_rejected_despite_short_error() {
        let result = json!({"ok":false,"error":"failed","extra":"x".repeat(32*1024*1024)});
        assert!(validate_reply("r:1", &result).is_err());
        let success = json!({"ok":true,"snapshot":{"state":null,"undo":null,"ready":false,"error":null},"extra":"x".repeat(32*1024*1024)});
        assert!(validate_reply("r:1", &success).is_err());
    }
    #[test]
    fn bridge_bounds_roles_and_published_payload() {
        assert!(authorize("main", "main").is_ok());
        assert!(authorize("widget", "main").is_err());
        assert!(validate_action("r:1", &json!({"type":"snapshot"})).is_ok());
        assert!(validate_action("", &json!({"type":"snapshot"})).is_err());
        assert!(validate_action("r:1", &json!(null)).is_err());
        assert!(validate_action("r:1", &json!({"note":"a".repeat(8192)})).is_err());
        assert!(
            validate_controller(&json!({"state":null,"undo":null,"ready":false,"error":null}))
                .is_ok()
        );
        assert!(
            validate_controller(&json!({"state":null,"undo":null,"ready":true,"error":null}))
                .is_err()
        );
        assert!(
            validate_controller(&json!({"state":null,"undo":null,"ready":false,"error":0}))
                .is_err()
        );
        assert!(validate_reply("r:1", &json!({"ok":false,"error":"disk full"})).is_ok());
        assert!(validate_reply(
            "r:1",
            &json!({"ok":true,"snapshot":{"state":null,"undo":null,"ready":false,"error":null}})
        )
        .is_ok());
        assert!(validate_reply("r:1", &json!({"ok":true})).is_err());
    }
}
