//! Tray text derived from the agent status. Pure, so it is unit-tested.

use serde_json::Value;

pub fn tooltip(status: Option<&Value>) -> String {
    let Some(s) = status else { return "ghost: agente não está em execução".into() };
    let conn = s["connection"]["status"].as_str().unwrap_or("");
    if conn == "revoked" {
        return "ghost: acesso revogado".into();
    }
    if let Some(w) = s["workloads"].as_array().and_then(|a| a.first()) {
        let pct = (w["progress"].as_f64().unwrap_or(0.0) * 100.0).round();
        return format!("ghost: executando {} ({pct}%)", w["jobName"].as_str().unwrap_or("trabalho"));
    }
    let base = match (s["control"].as_str(), s["state"].as_str()) {
        (Some("stopped"), _) => "desligado",
        (Some("paused"), _) => "pausado",
        (_, Some("available")) => "pronto para contribuir",
        (_, Some("running")) => "executando",
        _ => "aguardando",
    };
    let suffix = if conn == "connected" { "" } else { " · sem conexão com o servidor" };
    format!("ghost: {base}{suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tooltips() {
        assert_eq!(tooltip(None), "ghost: agente não está em execução");
        let s = json!({ "control": "stopped", "state": "stopped", "connection": { "status": "connected" }, "workloads": [] });
        assert_eq!(tooltip(Some(&s)), "ghost: desligado");
        let s = json!({ "control": "started", "state": "waiting", "connection": { "status": "reconnecting" }, "workloads": [] });
        assert_eq!(tooltip(Some(&s)), "ghost: aguardando · sem conexão com o servidor");
        let s = json!({ "control": "started", "state": "running", "connection": { "status": "connected" },
                        "workloads": [{ "jobName": "Render", "progress": 0.425 }] });
        assert_eq!(tooltip(Some(&s)), "ghost: executando Render (43%)");
    }
}
