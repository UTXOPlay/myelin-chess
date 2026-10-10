mod game;
mod session;
use serde_json::{json, Value};
use session::{AnyResult, App};
use std::{fs, io::Read, path::PathBuf};
use tiny_http::{Header, Method, Response, Server};

fn main() -> AnyResult<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("verify") {
        let path = args.get(2).ok_or("Usage: game verify evidence.json")?;
        if fs::metadata(path)?.len() > 32 * 1024 * 1024 {
            return Err("Export exceeds 32 MiB".into());
        }
        let v = serde_json::from_slice(&fs::read(path)?)?;
        println!(
            "{}",
            serde_json::to_string_pretty(&session::verify_export(&v)?)?
        );
        return Ok(());
    }
    let port = std::env::var("PORT")
        .ok()
        .map(|s| s.parse::<u16>())
        .transpose()?
        .unwrap_or(game::PORT);
    let dir = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "data".into()));
    let mut app = App::open(&dir)?;
    let server = Server::http(("127.0.0.1", port))?;
    println!(
        "{} — http://127.0.0.1:{port} (local shared session)",
        game::ID
    );
    for mut req in server.incoming_requests() {
        let path = req.url().split('?').next().unwrap_or("/").to_owned();
        let result: AnyResult<(Vec<u8>, &str)> = (|| {
            if req.method() == &Method::Post {
                let origin = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Origin"))
                    .map(|h| h.value.as_str());
                if origin.is_some_and(|o| {
                    o != format!("http://127.0.0.1:{port}")
                        && o != format!("http://localhost:{port}")
                }) {
                    return Err("Cross-origin request rejected".into());
                }
                if !req
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv("X-Myelin-Client") && h.value.as_str() == "game")
                {
                    return Err("Missing game client header".into());
                }
                let mut bytes = vec![];
                req.as_reader().take(4097).read_to_end(&mut bytes)?;
                if bytes.len() > 4096 {
                    return Err("Request too large".into());
                }
                let v = match path.as_str() {
                    "/api/new" => app.new_game()?,
                    "/api/action" => app.action(serde_json::from_slice::<Value>(&bytes)?)?,
                    "/api/replay" => app.replay()?,
                    _ => return Err("Unknown endpoint".into()),
                };
                return Ok((serde_json::to_vec(&v)?, "application/json"));
            }
            if req.method() != &Method::Get {
                return Err("Method not allowed".into());
            }
            if path == "/api/state" {
                return Ok((serde_json::to_vec(&app.view()?)?, "application/json"));
            }
            if path == "/api/export" {
                return Ok((
                    serde_json::to_vec_pretty(&app.export()?)?,
                    "application/json",
                ));
            }
            let file = match path.as_str() {
                "/" => "index.html",
                "/app.js" => "app.js",
                "/style.css" => "style.css",
                "/audio.js" => "audio.js",
                p if p.starts_with("/assets/") && !p.contains("..") && !p.contains('%') => &p[1..],
                _ => return Err("Not found".into()),
            };
            let mime = if file.ends_with(".html") {
                "text/html; charset=utf-8"
            } else if file.ends_with(".js") {
                "text/javascript"
            } else if file.ends_with(".css") {
                "text/css"
            } else if file.ends_with(".mp3") {
                "audio/mpeg"
            } else if file.ends_with(".ogg") {
                "audio/ogg"
            } else if file.ends_with(".png") {
                "image/png"
            } else if file.ends_with(".webp") {
                "image/webp"
            } else if file.ends_with(".svg") {
                "image/svg+xml"
            } else {
                "application/octet-stream"
            };
            Ok((
                fs::read(
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("web")
                        .join(file),
                )?,
                mime,
            ))
        })();
        let (bytes, mime, status) = match result {
            Ok((b, m)) => (b, m, 200),
            Err(e) => (
                serde_json::to_vec(&json!({"error":e.to_string()}))?,
                "application/json",
                400,
            ),
        };
        let mut response = Response::from_data(bytes).with_status_code(status);
        for (k,v) in [("Content-Type",mime),("Cache-Control","no-store"),("X-Content-Type-Options","nosniff"),("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")] {response.add_header(Header::from_bytes(k,v).unwrap());}
        if path == "/api/export" {
            response.add_header(
                Header::from_bytes("Content-Disposition", "attachment; filename=session.json")
                    .unwrap(),
            );
        }
        let _ = req.respond(response);
    }
    Ok(())
}
