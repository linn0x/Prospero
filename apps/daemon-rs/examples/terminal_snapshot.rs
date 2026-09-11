use std::io::Read;

use base64::{Engine, engine::general_purpose::STANDARD};
use prosperod_rs::terminal::{TerminalSize, screen::Screen};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    size: TerminalSize,
    chunks: Vec<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin()
        .take(1024 * 1024)
        .read_to_string(&mut input)?;
    let fixture: Fixture = serde_json::from_str(&input)?;
    fixture.size.validate()?;
    let mut screen = Screen::new(fixture.size);
    for chunk in fixture.chunks {
        screen.process(&STANDARD.decode(chunk)?);
    }
    println!("{}", serde_json::to_string(&screen.snapshot(1)?)?);
    Ok(())
}
