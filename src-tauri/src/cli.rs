use anyhow::{anyhow, Result};

/// Entry point for CLI mode. `args` is everything after the binary name.
pub async fn run(args: Vec<String>) -> Result<()> {
    match args.first().map(|s| s.as_str()) {
        Some("run") => cmd_run(&args[1..]).await,
        Some("serve") => crate::api::cmd_serve(&args[1..]).await,
        Some("preload") => cmd_preload(&args[1..]).await,
        Some("status") => cmd_status(&args[1..]).await,
        Some("stop") => cmd_stop().await,
        Some("models") => cmd_models(&args[1..]).await,
        Some("providers") => cmd_providers(&args[1..]).await,
        Some("families") => cmd_families(&args[1..]).await,
        Some("import") => cmd_import(&args[1..]).await,
        Some("export") => cmd_export(&args[1..]).await,
        Some("purge") => cmd_purge(&args[1..]).await,
        Some("update") => crate::self_update::cmd_update(&args[1..]).await,
        Some("fetch-onnxruntime") => cmd_fetch_onnxruntime().await,
        Some("help") | Some("--help") | Some("-h") => {
            print_help();
            Ok(())
        }
        Some("--version") | Some("-V") | Some("version") => {
            println!("myownllm {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some(unknown) => Err(anyhow!(
            "unknown command: {unknown}\nRun `myownllm help` for usage."
        )),
        None => {
            print_help();
            Ok(())
        }
    }
}

fn print_help() {
    println!(
        r#"myownllm — local AI, zero configuration

USAGE:
  myownllm [command] [flags]
  myownllm --version

COMMANDS:
  run           Start chat (terminal)
  serve         Start the OpenAI-compatible HTTP server
  preload       Pull and warm models for one or more modes
  status        Show current state (provider, family, recommended models)
  stop          Stop ollama serve
  models        Manage pulled models
  providers     Manage providers (publishers of family manifests)
  families      Pick the model family inside the active provider
  import <url>  Import config from URL or file
  export        Export config
  purge         Danger zone: delete models, conversations, or all app data
                Subcommands: models | conversations | data    (pass -f to skip prompt)
  update        Update to the latest release (one shot: check + download + apply)
                Subcommands: status | check | apply | enable | disable
  fetch-onnxruntime
                Download the pinned onnxruntime release into ~/.myownllm/runtime/.
                Use this if transcription fails with "onnxruntime isn't loaded"
                and the install script didn't fetch it for you.

FLAGS (run):
  --mode <text|transcribe>
  --model <name>        Override model
  --profile <url>       One-off manifest URL

FLAGS (serve):
  --host <addr>         Bind address (default 127.0.0.1)
  --port <n>            Port (default 1473)
  --cors-allow-all      Permit cross-origin requests
  --bearer-token <tok>  Require this token via Authorization: Bearer
  --no-ollama           Don't start ollama (assume it's already running)

FLAGS (preload):
  <mode...>             One or more of text, transcribe
  --track               Persist to config.tracked_modes
  --no-warm             Skip the post-pull warm-up call
  --json                Newline-delimited JSON event output

FLAGS (purge):
  -f, --force           Skip the typed confirmation prompt (for scripts / CI)
  --json                Emit the post-purge report as JSON instead of a summary

FLAGS (providers use):
  --immediate           After swap, evict the previously-resolved tag now

FLAGS (global):
  --json                Machine-readable JSON output
  --quiet               Suppress progress output
"#
    );
}

async fn cmd_run(args: &[String]) -> Result<()> {
    let mut mode = "text".to_string();
    let mut model_override: Option<String> = None;
    let mut profile_url: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--mode" => {
                mode = args.get(i + 1).cloned().unwrap_or_default();
                i += 2;
            }
            "--model" => {
                model_override = args.get(i + 1).cloned();
                i += 2;
            }
            "--profile" => {
                profile_url = args.get(i + 1).cloned();
                i += 2;
            }
            _ => {
                i += 1;
            }
        }
    }

    if !crate::ollama::is_installed() {
        eprintln!("Ollama not found. Installing…");
        crate::ollama::install().await?;
    }

    eprint!("Starting ollama… ");
    crate::ollama::ensure_running().await?;
    eprintln!("ok");

    let hw = crate::hardware::detect()?;
    let model = if let Some(m) = model_override {
        m
    } else {
        crate::resolver::resolve_with_hardware(&mode, &hw, profile_url.as_deref()).await?
    };

    eprintln!("Model: {model}  Mode: {mode}");

    eprint!("Pulling {model}… ");
    crate::ollama::pull_with(&model, |evt| {
        eprint!(
            "\rPulling {model}… {}                                ",
            evt.render()
        );
        let _ = std::io::Write::flush(&mut std::io::stderr());
    })
    .await?;
    eprintln!("\rPulling {model}… done                                      ");

    chat_loop(&model, &mode).await
}

async fn chat_loop(model: &str, _mode: &str) -> Result<()> {
    use std::io::{self, BufRead, Write};
    let stdin = io::stdin();
    let mut history: Vec<serde_json::Value> = Vec::new();

    println!("MyOwnLLM — {model}  (Ctrl+C or type 'exit' to quit)\n");

    loop {
        print!("> ");
        io::stdout().flush()?;
        let mut line = String::new();
        if stdin.lock().read_line(&mut line)? == 0 {
            break;
        } // EOF
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line == "exit" || line == "quit" {
            break;
        }

        history.push(serde_json::json!({ "role": "user", "content": line }));

        let body = serde_json::json!({
            "model": model,
            "messages": history,
            "stream": false
        });

        let response = tokio::process::Command::new("curl")
            .args([
                "-sf",
                "-X",
                "POST",
                "http://127.0.0.1:11434/api/chat",
                "-H",
                "Content-Type: application/json",
                "-d",
                &body.to_string(),
            ])
            .output()
            .await?;

        if !response.status.success() {
            eprintln!("(ollama request failed)");
            continue;
        }

        let resp: serde_json::Value = serde_json::from_slice(&response.stdout).unwrap_or_default();
        let content = resp["message"]["content"]
            .as_str()
            .unwrap_or("(no response)");
        println!("{content}\n");
        history.push(serde_json::json!({ "role": "assistant", "content": content }));
    }
    Ok(())
}

async fn cmd_status(args: &[String]) -> Result<()> {
    let json = args.contains(&"--json".to_string());
    let hw = crate::hardware::detect()?;
    let config = load_config()?;

    let active_provider = config["active_provider"]
        .as_str()
        .unwrap_or("(none)")
        .to_string();
    let active_family = config["active_family"].as_str().unwrap_or("").to_string();
    let active_mode = config["active_mode"].as_str().unwrap_or("text").to_string();

    // Resolve recommendations for every tracked mode so the user can see the
    // whole picture from one command — this is the headline feature of `status`.
    let tracked: Vec<String> = config["tracked_modes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_else(|| vec![active_mode.clone()]);

    let mut recommendations: Vec<(String, Option<String>)> = Vec::new();
    for m in &tracked {
        let resolved = crate::resolver::resolve(m).await.ok();
        recommendations.push((m.clone(), resolved));
    }

    // List the families the active provider exposes (if we can fetch its manifest).
    let provider_url = crate::resolver::active_provider_url(&config);
    let mut families: Vec<(String, String)> = Vec::new();
    if let Some(url) = provider_url {
        if let Ok(manifest) = crate::resolver::fetch_or_load_manifest(&url).await {
            if let Some(fobj) = manifest["families"].as_object() {
                for (name, family) in fobj {
                    let label = family["label"].as_str().unwrap_or(name).to_string();
                    families.push((name.clone(), label));
                }
            }
        }
    }

    let running = {
        let out = tokio::process::Command::new("curl")
            .args(["-sf", "--max-time", "1", "http://127.0.0.1:11434/"])
            .output()
            .await;
        out.map(|o| o.status.success()).unwrap_or(false)
    };

    if json {
        let recs_json: serde_json::Map<String, serde_json::Value> = recommendations
            .iter()
            .map(|(m, r)| {
                (
                    m.clone(),
                    r.as_ref()
                        .map(|s| serde_json::json!(s))
                        .unwrap_or(serde_json::Value::Null),
                )
            })
            .collect();
        let fam_json: Vec<serde_json::Value> = families
            .iter()
            .map(|(k, l)| serde_json::json!({"name": k, "label": l}))
            .collect();
        println!(
            "{}",
            serde_json::json!({
                "active_provider": active_provider,
                "active_family": active_family,
                "active_mode": active_mode,
                "ollama_running": running,
                "hardware": hw,
                "recommendations": recs_json,
                "families": fam_json,
            })
        );
    } else {
        println!("Provider : {active_provider}");
        println!("Family   : {active_family}");
        println!("Mode     : {active_mode}");
        println!("Ollama   : {}", if running { "running" } else { "stopped" });
        if let Some(soc) = hw.soc.as_deref() {
            println!("System   : {soc} ({})", hw.arch);
        } else {
            println!("System   : {}", hw.arch);
        }
        println!(
            "VRAM     : {}",
            hw.vram_gb
                .map(|v| format!("{:.1} GB ({:?})", v, hw.gpu_type))
                .unwrap_or_else(|| "none (CPU)".into())
        );
        println!("RAM      : {:.1} GB", hw.ram_gb);
        println!("Disk free: {:.1} GB", hw.disk_free_gb);

        if !families.is_empty() {
            println!("\nFamilies in {active_provider}:");
            for (name, label) in &families {
                let marker = if *name == active_family { "*" } else { " " };
                println!(" {marker} {name:<14} {label}");
            }
        }

        if !recommendations.is_empty() {
            println!("\nRecommended models for this hardware:");
            for (mode, resolved) in &recommendations {
                let tag = resolved.as_deref().unwrap_or("(unresolved)");
                println!("  {mode:<10} → {tag}");
            }
        }
    }
    Ok(())
}

async fn cmd_stop() -> Result<()> {
    crate::ollama::stop().await?;
    println!("ollama stopped");
    Ok(())
}

async fn cmd_models(args: &[String]) -> Result<()> {
    let json = args.contains(&"--json".to_string());

    match args.first().map(|s| s.as_str()) {
        None | Some("--json") => {
            // List models
            let pulled = crate::ollama::list_models().await?;
            let config = load_config()?;
            let kept: Vec<&str> = config["kept_models"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            let overrides = config["mode_overrides"].as_object();
            let override_models: Vec<&str> = overrides
                .map(|o| o.values().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();

            if json {
                let items: Vec<_> = pulled
                    .iter()
                    .map(|m| {
                        serde_json::json!({
                            "name": m.name,
                            "size_bytes": m.size,
                            "kept": kept.contains(&m.name.as_str()),
                            "override_for": overrides.map(|o| {
                                o.iter().filter(|(_, v)| v.as_str() == Some(&m.name))
                                        .map(|(k, _)| k.clone()).collect::<Vec<_>>()
                            }).unwrap_or_default(),
                        })
                    })
                    .collect();
                println!("{}", serde_json::to_string_pretty(&items)?);
            } else {
                println!("{:<35} {:>10}  FLAGS", "NAME", "SIZE");
                for m in &pulled {
                    let size_gb = m.size as f64 / 1024.0 / 1024.0 / 1024.0;
                    let mut flags = vec![];
                    if kept.contains(&m.name.as_str()) {
                        flags.push("kept");
                    }
                    if override_models.contains(&m.name.as_str()) {
                        flags.push("override");
                    }
                    println!("{:<35} {:>9.1}G  {}", m.name, size_gb, flags.join(" "));
                }
            }
        }
        Some("keep") => {
            let name = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: myownllm models keep <model>"))?;
            let mut config = load_config()?;
            let kept = config["kept_models"].as_array_mut().map(|a| {
                if !a.iter().any(|v| v.as_str() == Some(name)) {
                    a.push(serde_json::json!(name));
                }
            });
            if kept.is_none() {
                config["kept_models"] = serde_json::json!([name]);
            }
            save_config(&config)?;
            println!("Kept: {name}");
        }
        Some("unkeep") => {
            let name = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: myownllm models unkeep <model>"))?;
            let mut config = load_config()?;
            if let Some(arr) = config["kept_models"].as_array_mut() {
                arr.retain(|v| v.as_str() != Some(name));
            }
            save_config(&config)?;
            println!("Unpinned: {name}");
        }
        Some("override") => {
            let mode = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: myownllm models override <mode> <model|--clear>"))?;
            let model_or_clear = args
                .get(2)
                .ok_or_else(|| anyhow!("usage: myownllm models override <mode> <model|--clear>"))?;
            let mut config = load_config()?;
            if config["mode_overrides"].is_null() {
                config["mode_overrides"] = serde_json::json!({});
            }
            if model_or_clear == "--clear" {
                config["mode_overrides"][mode] = serde_json::Value::Null;
                println!("Override for {mode} cleared");
            } else {
                config["mode_overrides"][mode] = serde_json::json!(model_or_clear);
                println!("Override for {mode}: {model_or_clear}");
            }
            save_config(&config)?;
        }
        Some("prune") => {
            let config = load_config()?;
            let kept: Vec<&str> = config["kept_models"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            let override_models: Vec<&str> = config["mode_overrides"]
                .as_object()
                .map(|o| o.values().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();

            let status_path = crate::myownllm_dir()?.join("cache/model-status.json");
            let unrecommended: Vec<String> = if status_path.exists() {
                let v: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(&status_path)?)?;
                v.as_object()
                    .map(|o| {
                        o.iter()
                            .filter(|(_, info)| {
                                info["recommended_by"]
                                    .as_array()
                                    .map(|a| a.is_empty())
                                    .unwrap_or(true)
                            })
                            .map(|(k, _)| k.clone())
                            .collect()
                    })
                    .unwrap_or_default()
            } else {
                vec![]
            };

            for model in &unrecommended {
                if kept.contains(&model.as_str()) || override_models.contains(&model.as_str()) {
                    continue;
                }
                println!("Removing {model}…");
                let _ = crate::ollama::delete_model(model).await;
            }
            println!("Prune complete");
        }
        Some("rm") => {
            let name = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: myownllm models rm <model>"))?;
            // Remove keep + override entries for this model too
            let mut config = load_config()?;
            if let Some(arr) = config["kept_models"].as_array_mut() {
                arr.retain(|v| v.as_str() != Some(name));
            }
            if let Some(overrides) = config["mode_overrides"].as_object_mut() {
                for v in overrides.values_mut() {
                    if v.as_str() == Some(name) {
                        *v = serde_json::Value::Null;
                    }
                }
            }
            save_config(&config)?;
            crate::ollama::delete_model(name).await?;
            println!("Removed: {name}");
        }
        Some(unknown) => return Err(anyhow!("unknown models subcommand: {unknown}")),
    }
    Ok(())
}

async fn cmd_providers(args: &[String]) -> Result<()> {
    match args.first().map(|s| s.as_str()) {
        None => {
            let config = load_config()?;
            let providers = config["providers"].as_array().cloned().unwrap_or_default();
            let active = config["active_provider"].as_str().unwrap_or("");
            for p in &providers {
                let name = p["name"].as_str().unwrap_or("?");
                let marker = if name == active { "*" } else { " " };
                println!(" {marker} {}  {}", name, p["url"].as_str().unwrap_or("?"));
            }
        }
        Some("add") => {
            let url = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: myownllm providers add <url> --name <name>"))?;
            let name = flag_value(args, "--name").unwrap_or_else(|| url.clone());
            let mut config = load_config()?;
            let providers = config["providers"]
                .as_array_mut()
                .ok_or_else(|| anyhow!("config missing providers"))?;
            if providers.iter().any(|p| p["name"].as_str() == Some(&name)) {
                for p in providers.iter_mut() {
                    if p["name"].as_str() == Some(&name) {
                        p["url"] = serde_json::json!(url);
                    }
                }
            } else {
                providers.push(serde_json::json!({ "name": name, "url": url }));
            }
            save_config(&config)?;
            println!("Provider added: {name}");
            crate::preload::ensure_tracked_models(false).await.ok();
        }
        Some("use") => {
            let name = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: myownllm providers use <name>"))?;
            let immediate = args.contains(&"--immediate".to_string());
            let mut config = load_config()?;
            let providers = config["providers"].as_array().cloned().unwrap_or_default();
            if !providers.iter().any(|p| p["name"].as_str() == Some(name)) {
                return Err(anyhow!("provider '{name}' not found"));
            }
            // Snapshot pre-swap resolved tags (for --immediate eviction).
            let pre_tags = if immediate {
                resolved_tags_for_tracked().await.unwrap_or_default()
            } else {
                vec![]
            };
            config["active_provider"] = serde_json::json!(name);
            // Reset active_family to whatever the new manifest considers default,
            // so the resolver doesn't silently fall back to a stale name.
            if let Some(url) = config["providers"]
                .as_array()
                .and_then(|a| a.iter().find(|p| p["name"].as_str() == Some(name)))
                .and_then(|p| p["url"].as_str())
                .map(str::to_string)
            {
                if let Ok(manifest) = crate::resolver::fetch_or_load_manifest(&url).await {
                    if let Some(default_family) = manifest["default_family"].as_str() {
                        if !default_family.is_empty() {
                            config["active_family"] = serde_json::json!(default_family);
                        }
                    }
                }
            }
            save_config(&config)?;
            println!("Active provider: {name}");

            crate::preload::ensure_tracked_models(false).await.ok();

            if immediate {
                let post_tags = resolved_tags_for_tracked().await.unwrap_or_default();
                let post_set: std::collections::HashSet<_> = post_tags.iter().collect();
                for tag in pre_tags {
                    if post_set.contains(&tag) {
                        continue;
                    }
                    eprintln!("Evicting old tag (--immediate): {tag}");
                    let _ = crate::ollama::delete_model(&tag).await;
                }
            }
        }
        Some("rm") => {
            let name = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: myownllm providers rm <name>"))?;
            let mut config = load_config()?;
            if config["active_provider"].as_str() == Some(name) {
                return Err(anyhow!(
                    "cannot remove active provider; switch first with `myownllm providers use`"
                ));
            }
            if let Some(arr) = config["providers"].as_array_mut() {
                arr.retain(|p| p["name"].as_str() != Some(name));
            }
            save_config(&config)?;
            println!("Provider removed: {name}");
            crate::preload::ensure_tracked_models(false).await.ok();
        }
        Some("show") => {
            let name = args.get(1);
            let config = load_config()?;
            let active = config["active_provider"].as_str().unwrap_or("");
            let target = name.map(|s| s.as_str()).unwrap_or(active);
            let providers = config["providers"].as_array().cloned().unwrap_or_default();
            let url = providers
                .iter()
                .find(|p| p["name"].as_str() == Some(target))
                .and_then(|p| p["url"].as_str())
                .ok_or_else(|| anyhow!("provider '{target}' not found"))?
                .to_string();
            // Pretty-print the families this provider exposes; falling back to a
            // raw fetch keeps `providers show <name>` debuggable when the
            // manifest doesn't parse.
            match crate::resolver::fetch_or_load_manifest(&url).await {
                Ok(manifest) => {
                    let active_family = config["active_family"].as_str().unwrap_or("");
                    println!("{target}  ({url})");
                    println!(
                        "  default family : {}",
                        manifest["default_family"].as_str().unwrap_or("?")
                    );
                    if let Some(fobj) = manifest["families"].as_object() {
                        println!("  families:");
                        for (name, family) in fobj {
                            let marker = if name == active_family { "*" } else { " " };
                            let label = family["label"].as_str().unwrap_or(name);
                            println!("   {marker} {name:<14} {label}");
                            if let Some(desc) = family["description"].as_str() {
                                println!("       {desc}");
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("(could not load manifest: {e})");
                    let out = tokio::process::Command::new("curl")
                        .args(["-sf", "--max-time", "10", &url])
                        .output()
                        .await?;
                    println!("{}", String::from_utf8_lossy(&out.stdout));
                }
            }
        }
        Some("reset") => {
            merge_preset_providers()?;
            println!("Preset providers merged");
        }
        Some(unknown) => return Err(anyhow!("unknown providers subcommand: {unknown}")),
    }
    Ok(())
}

async fn cmd_families(args: &[String]) -> Result<()> {
    let config = load_config()?;
    let provider_url = crate::resolver::active_provider_url(&config)
        .ok_or_else(|| anyhow!("no active provider; add one with `myownllm providers add`"))?;
    let manifest = crate::resolver::fetch_or_load_manifest(&provider_url).await?;
    let active_family = config["active_family"].as_str().unwrap_or("").to_string();

    match args.first().map(|s| s.as_str()) {
        None | Some("--json") => {
            let json = args.contains(&"--json".to_string());
            let entries: Vec<(String, String, Option<String>)> = manifest["families"]
                .as_object()
                .map(|fobj| {
                    fobj.iter()
                        .map(|(name, f)| {
                            (
                                name.clone(),
                                f["label"].as_str().unwrap_or(name).to_string(),
                                f["description"].as_str().map(str::to_string),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();

            if json {
                let arr: Vec<_> = entries
                    .iter()
                    .map(|(name, label, desc)| {
                        serde_json::json!({
                            "name": name,
                            "label": label,
                            "description": desc,
                            "active": *name == active_family,
                        })
                    })
                    .collect();
                println!("{}", serde_json::to_string_pretty(&arr)?);
            } else {
                let provider_name = config["active_provider"].as_str().unwrap_or("(none)");
                println!("Families in {provider_name}:");
                for (name, label, desc) in &entries {
                    let marker = if *name == active_family { "*" } else { " " };
                    println!(" {marker} {name:<14} {label}");
                    if let Some(d) = desc {
                        println!("       {d}");
                    }
                }
            }
        }
        Some("use") => {
            let name = args
                .get(1)
                .ok_or_else(|| anyhow!("usage: myownllm families use <name>"))?;
            let exists = manifest["families"]
                .as_object()
                .map(|f| f.contains_key(name))
                .unwrap_or(false);
            if !exists {
                return Err(anyhow!(
                    "family '{name}' not found in active provider's manifest"
                ));
            }
            let mut config = load_config()?;
            config["active_family"] = serde_json::json!(name);
            save_config(&config)?;
            println!("Active family: {name}");
            crate::preload::ensure_tracked_models(false).await.ok();
        }
        Some("show") => {
            let target = args
                .get(1)
                .map(|s| s.as_str())
                .unwrap_or(active_family.as_str());
            let family = manifest["families"]
                .get(target)
                .ok_or_else(|| anyhow!("family '{target}' not found"))?;
            let label = family["label"].as_str().unwrap_or(target);
            println!("{target}  ({label})");
            if let Some(desc) = family["description"].as_str() {
                println!("  {desc}");
            }
            println!(
                "  default mode: {}",
                family["default_mode"].as_str().unwrap_or("text")
            );
            if let Some(modes) = family["modes"].as_object() {
                for (mode_name, mode_spec) in modes {
                    println!("\n  mode {mode_name}:");
                    if let Some(tiers) = mode_spec["tiers"].as_array() {
                        for tier in tiers {
                            let vram = tier["min_vram_gb"].as_f64().unwrap_or(0.0);
                            let ram = tier["min_ram_gb"].as_f64().unwrap_or(0.0);
                            let unified = tier["min_unified_ram_gb"].as_f64();
                            let model = tier["model"].as_str().unwrap_or("?");
                            match unified {
                                Some(u) => println!(
                                    "    ≥{vram:>3.0} GB VRAM · ≥{ram:>3.0} GB RAM (discrete) · ≥{u:>3.0} GB RAM (unified)   {model}"
                                ),
                                None => println!(
                                    "    ≥{vram:>3.0} GB VRAM · ≥{ram:>3.0} GB RAM   {model}"
                                ),
                            }
                        }
                    }
                }
            }
        }
        Some(unknown) => return Err(anyhow!("unknown families subcommand: {unknown}")),
    }
    Ok(())
}

async fn cmd_import(args: &[String]) -> Result<()> {
    let url_or_path = args
        .first()
        .ok_or_else(|| anyhow!("usage: myownllm import <url|path>"))?;
    let json_str = if url_or_path.starts_with("http://") || url_or_path.starts_with("https://") {
        let out = tokio::process::Command::new("curl")
            .args(["-sf", "--max-time", "10", url_or_path])
            .output()
            .await?;
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else {
        std::fs::read_to_string(url_or_path)?
    };

    let imported: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|_| anyhow!("invalid config JSON at {url_or_path}"))?;
    let mut config = load_config()?;

    // Merge providers by name
    if let Some(new_providers) = imported["providers"].as_array() {
        let existing = config["providers"]
            .as_array_mut()
            .ok_or_else(|| anyhow!("config missing providers"))?;
        for p in new_providers {
            let name = p["name"].as_str().unwrap_or("");
            if !existing.iter().any(|e| e["name"].as_str() == Some(name)) {
                existing.push(p.clone());
                println!("+ provider: {name}");
            }
        }
    }

    save_config(&config)?;
    println!("Import complete");
    Ok(())
}

async fn cmd_export(args: &[String]) -> Result<()> {
    let as_url = args.contains(&"--url".to_string());
    let config = load_config()?;
    let export = serde_json::json!({ "providers": config["providers"].clone() });

    if as_url {
        let encoded = base64_encode(&export.to_string());
        println!("myownllm:import:{encoded}");
    } else {
        println!("{}", serde_json::to_string_pretty(&export)?);
    }
    Ok(())
}

/// Danger-zone CLI dispatcher: maps `myownllm purge <tier>` to the same
/// purge functions the GUI's "Danger zone" buttons call. The tier names
/// (`models`, `conversations`, `data`) match the three sections in the
/// Storage tab and the three Tauri commands one-for-one. Without `-f`
/// each tier prints a warning and waits for the user to type the
/// confirmation phrase verbatim; with `-f` the prompt is skipped so
/// scripts and CI can use the same surface.
async fn cmd_purge(args: &[String]) -> Result<()> {
    let force = args.iter().any(|a| a == "-f" || a == "--force");
    let json = args.contains(&"--json".to_string());
    let tier = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .map(|s| s.as_str())
        .ok_or_else(|| {
            anyhow!("usage: myownllm purge <models|conversations|data> [-f] [--json]")
        })?;

    let (label, challenge, blurb) = match tier {
        "models" => (
            "all models",
            "delete all models",
            "Removes every pulled Ollama tag, on-disk ASR / diarize artifacts, \
             and resets your kept-list and mode overrides. Provider list and \
             active family are kept. Models will be re-downloaded on next use.",
        ),
        "conversations" => (
            "all conversations",
            "delete all conversations",
            "Wipes every saved conversation under your conversations folder, \
             talking-points sidecars and folders included.",
        ),
        "data" => (
            "all app data and downloads",
            "delete everything",
            "Stops the managed Ollama, drops every model, and removes the \
             entire ~/.myownllm/ tree (config, cache, transcribe buffer, \
             updates, legacy dirs). A redirected conversations folder \
             outside ~/.myownllm/ is wiped too. Next launch starts fresh.",
        ),
        other => {
            return Err(anyhow!(
                "unknown purge tier: {other}\n\
                 expected one of: models, conversations, data"
            ))
        }
    };

    if !force {
        eprintln!("About to delete {label}.");
        eprintln!("{blurb}");
        eprintln!();
        eprintln!("This is irreversible. There is no trash.");
        eprintln!("Type the phrase to confirm (or anything else to abort):");
        eprintln!("  {challenge}");
        eprint!("> ");
        use std::io::Write;
        std::io::stderr().flush().ok();
        let mut typed = String::new();
        std::io::stdin().read_line(&mut typed)?;
        if typed.trim() != challenge {
            eprintln!("Aborted.");
            return Ok(());
        }
    }

    let report = match tier {
        "models" => crate::purge::purge_models().await?,
        "conversations" => crate::purge::purge_conversations()?,
        "data" => crate::purge::purge_all().await?,
        _ => unreachable!(),
    };

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        let gb = report.bytes_freed as f64 / 1024.0 / 1024.0 / 1024.0;
        println!(
            "Freed {:.2} GB · removed {} item{}",
            gb,
            report.items_removed,
            if report.items_removed == 1 { "" } else { "s" }
        );
        for e in &report.errors {
            eprintln!("  ! {e}");
        }
        if tier == "data" {
            eprintln!("Restart MyOwnLLM to come back up against compiled-in defaults.");
        }
    }
    Ok(())
}

async fn cmd_preload(args: &[String]) -> Result<()> {
    let track = args.contains(&"--track".to_string());
    let no_warm = args.contains(&"--no-warm".to_string());
    let json = args.contains(&"--json".to_string());

    let modes: Vec<String> = args
        .iter()
        .filter(|a| !a.starts_with("--"))
        .cloned()
        .collect();
    if modes.is_empty() {
        return Err(anyhow!(
            "usage: myownllm preload <mode...> [--track] [--no-warm] [--json]"
        ));
    }
    for m in &modes {
        if !crate::resolver::KNOWN_MODES.contains(&m.as_str()) {
            return Err(anyhow!(
                "unknown mode '{m}' (expected one of: text, transcribe, diarize, speak, embed)"
            ));
        }
    }

    if !crate::ollama::is_installed() {
        eprintln!("Ollama not found. Installing…");
        crate::ollama::install().await?;
    }
    crate::ollama::ensure_running().await?;

    let warm = !no_warm;
    crate::preload::preload(&modes, track, warm, |evt| {
        if json {
            println!("{}", serde_json::to_string(&evt).unwrap_or_default());
        } else {
            match evt.status.as_str() {
                "resolved" => eprintln!("[{}] resolved → {}", evt.mode, evt.model),
                "pulling" => eprint!("\r[{}] pulling {} {}", evt.mode, evt.model, evt.detail),
                "pulled" => eprintln!(
                    "\r[{}] pulled  {}                                              ",
                    evt.mode, evt.model
                ),
                "warming" => eprintln!("[{}] warming {}", evt.mode, evt.model),
                "ready" => eprintln!("[{}] ready   {}", evt.mode, evt.model),
                "error" => eprintln!("[{}] ERROR   {}: {}", evt.mode, evt.model, evt.detail),
                _ => eprintln!("[{}] {} {}", evt.mode, evt.status, evt.detail),
            }
        }
    })
    .await?;
    Ok(())
}

async fn resolved_tags_for_tracked() -> Result<Vec<String>> {
    let modes = crate::resolver::tracked_modes()?;
    let mut tags = Vec::new();
    for m in modes {
        if let Ok(t) = crate::resolver::resolve(&m).await {
            tags.push(t);
        }
    }
    tags.sort();
    tags.dedup();
    Ok(tags)
}

// Config helpers — thin wrappers over the resolver module so cli.rs and api.rs
// share one implementation.

pub fn load_config() -> Result<serde_json::Value> {
    crate::resolver::load_config_value()
}

fn save_config(config: &serde_json::Value) -> Result<()> {
    crate::resolver::save_config_value(config)
}

fn merge_preset_providers() -> Result<()> {
    let preset_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../providers/preset.json");
    if !preset_path.exists() {
        return Ok(());
    }
    let preset: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(preset_path)?)?;
    let mut config = load_config()?;
    let providers = config["providers"]
        .as_array_mut()
        .ok_or_else(|| anyhow!("config missing providers"))?;
    for p in preset {
        let name = p["name"].as_str().unwrap_or("").to_string();
        if !providers.iter().any(|e| e["name"].as_str() == Some(&name)) {
            providers.push(p);
        }
    }
    save_config(&config)
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == flag).map(|w| w[1].clone())
}

fn base64_encode(s: &str) -> String {
    // Simple URL-safe base64 using standard library.
    // Using a manual impl to avoid adding a dep.
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let bytes = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i] as u32;
        let b1 = bytes.get(i + 1).copied().unwrap_or(0) as u32;
        let b2 = bytes.get(i + 2).copied().unwrap_or(0) as u32;
        out.push(CHARS[((b0 >> 2) & 0x3f) as usize] as char);
        out.push(CHARS[(((b0 << 4) | (b1 >> 4)) & 0x3f) as usize] as char);
        if i + 1 < bytes.len() {
            out.push(CHARS[(((b1 << 2) | (b2 >> 6)) & 0x3f) as usize] as char);
        }
        if i + 2 < bytes.len() {
            out.push(CHARS[(b2 & 0x3f) as usize] as char);
        }
        i += 3;
    }
    out
}

/// `myownllm fetch-onnxruntime` — explicit, sync alternative to the
/// Tauri setup hook's auto-fetch. Useful for headless installs and as
/// a recovery path the error message can point users at.
async fn cmd_fetch_onnxruntime() -> Result<()> {
    use std::io::Write;
    let target = crate::ort_install::target_dylib_path()?;
    if target.exists() {
        println!("onnxruntime already present at {}", target.display());
        return Ok(());
    }
    println!("Fetching onnxruntime → {} …", target.display());

    // Carriage-return progress on a single stderr line. Stays
    // readable in CI logs (each MiB sample is dropped onto its own
    // line by most CI captures) but renders as a single updating bar
    // in an interactive terminal.
    let progress: Box<crate::ort_install::ProgressFn> = Box::new(|bytes, total| {
        if total > 0 {
            let pct = (bytes as f64 / total as f64 * 100.0) as u64;
            let _ = write!(
                std::io::stderr(),
                "\r  {pct:>3}%  {bytes:>10} / {total:>10} bytes"
            );
        } else {
            let _ = write!(std::io::stderr(), "\r  {bytes:>10} bytes");
        }
        let _ = std::io::stderr().flush();
    });

    // Synchronous; spawn_blocking keeps it off the async runtime's
    // worker pool. Mapping the JoinError → anyhow keeps the `?` chain.
    let path =
        tokio::task::spawn_blocking(move || crate::ort_install::ensure_runtime_dylib(progress))
            .await
            .map_err(|e| anyhow!("spawn_blocking join failed: {e}"))??;

    eprintln!(); // terminate the carriage-return progress line
    println!("onnxruntime installed at {}", path.display());
    Ok(())
}
